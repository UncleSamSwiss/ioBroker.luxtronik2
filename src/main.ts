/*
 * Created with @iobroker/create-adapter v1.30.1
 */
import * as utils from '@iobroker/adapter-core';
import luxtronik from 'luxtronik2';
import { AddressInfo, createConnection, createServer, Server } from 'net';
import WebSocket from 'ws';
import { parseStringPromise } from 'xml2js';
import {
    ContentItem,
    ContentSection,
    ItemBase,
    Message,
    NavigationItem,
    NumberContentItem,
    ReadOnlyContentItem,
    SelectContentItem,
} from './lux-messages';
import { luxMeta } from './lux-meta';

class Luxtronik2 extends utils.Adapter {
    private webSocket?: WebSocket;
    private luxtronik?: any;
    private proxyServer?: Server;

    private closing = false;

    private navigationSections: NavigationItem[] = [];
    private currentNavigationSection = 0;

    private handlers: Record<string, ItemHandler<any>> = {};

    private wsRefreshTimeout?: NodeJS.Timeout;
    private luxRefreshTimeout?: NodeJS.Timeout;

    private requestedUpdates: { id: string; value: string | number }[] = [];
    private isSaving = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            dirname: __dirname.indexOf('node_modules') !== -1 ? undefined : __dirname + '/../',
            ...options,
            name: 'luxtronik2',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);

        this.createWebSocket();
        if (this.config.useLuxProxy) {
            await this.createLuxTreeAsync();
            this.createLuxtronikProxy();
        } else if (this.config.luxPort) {
            await this.createLuxTreeAsync();
            this.createLuxtronikConnection(this.config.host, this.config.luxPort);
        }
    }

    private createWebSocket(): void {
        if (!this.config.port) {
            return;
        }

        const uri = `ws://${this.config.host}:${this.config.port}`;
        const login = `LOGIN;${this.config.password}`;

        this.webSocket = new WebSocket(uri, 'Lux_WS');
        this.log.info('Connecting to ' + uri);

        this.webSocket.on('open', () => {
            try {
                this.log.info('Connected to ' + uri);
                this.webSocket?.send(login);
                this.webSocket?.send('REFRESH');
                this.setState('info.connection', true, true);
            } catch (e) {
                this.log.error(`Couldn't send login, ${e}`);
                this.webSocket?.close();
            }
        });

        this.webSocket.on('message', (msg: string) => this.handleWsMessage(msg));

        this.webSocket.on('error', (err: Error) => {
            if (this.closing) {
                return;
            }
            this.log.error(`Got WebSocket error ${err}`);

            // not available in unit tests
            if (this.restart) {
                this.restart();
            }
        });

        this.webSocket.on('close', () => {
            if (this.closing) {
                return;
            }
            this.log.error('Got unexpected close event');

            // not available in unit tests
            if (this.restart) {
                this.restart();
            }
        });
    }

    private async createLuxTreeAsync(): Promise<void> {
        for (const sectionName in luxMeta) {
            const section = luxMeta[sectionName];
            await this.extendObjectAsync(sectionName, {
                type: 'channel',
                common: {
                    name: sectionName,
                },
            });
            for (const itemName in section) {
                const item = section[itemName];
                const id = `${sectionName}.${itemName}`;
                await this.extendObjectAsync(id, {
                    type: 'state',
                    common: {
                        name: itemName,
                        read: true,
                        write: !!item.writeName,
                        type: item.type,
                        role: item.role,
                        unit: item.unit,
                        min: item.min,
                        max: item.max,
                        states: item.states,
                    },
                });
                if (item.writeName) {
                    this.subscribeStates(id);
                }
            }
        }
    }

    private createLuxtronikConnection(host: string, port: number): void {
        if (!port) {
            return;
        }

        this.log.info(`Connecting to ${host}:${port}`);
        this.luxtronik = new luxtronik.createConnection(host, port);
        this.requestLuxtronikData();
    }

    private requestLuxtronikData(): void {
        this.luxtronik.read((err: any, data: Record<string, Record<string, string | number>>) => {
            if (err) {
                this.log.error(`Luxtronik read error: ${err}`);
                this.luxRefreshTimeout = setTimeout(
                    () => this.requestLuxtronikData(),
                    this.config.refreshInterval * 1000,
                );
                return;
            }

            this.setState('info.connection', true, true);
            this.handleLuxtronikDataAsync(data).catch((e) => this.log.error(`Couldn't handle luxtronik data ${e}`));
        });
    }

    /**
     * Creates a TCP proxy for the Luxtronik port.
     * This is required in some instances because the underlying library expects
     * all data to arrive in a single batch (which it sometimes doesn't).
     */
    private createLuxtronikProxy(): void {
        const localhost = '127.0.0.1';
        this.proxyServer = createServer((client) => {
            this.log.debug('Received proxy connect');
            const forward = createConnection(this.config.luxPort, this.config.host);
            client.on('close', () => {
                forward.end();
                this.log.debug('Client closed proxy connection');
            });
            forward.on('close', () => {
                client.end();
                this.log.debug('Luxtronik closed proxy connection');
            });
            client.on('data', (data) => {
                this.log.silly(`Received ${data.length} bytes from client`);
                forward.write(data);
            });

            let receiveBuffer: Buffer | undefined;
            let receiveTimeout: NodeJS.Timeout | undefined;
            forward.on('data', (data) => {
                this.log.silly(`Received ${data.length} bytes from Luxtronik`);
                if (receiveTimeout) {
                    clearTimeout(receiveTimeout);
                }

                if (receiveBuffer) {
                    receiveBuffer = Buffer.concat([receiveBuffer, data]);
                } else {
                    receiveBuffer = Buffer.from(data);
                }

                receiveTimeout = setTimeout(() => {
                    if (receiveBuffer) {
                        this.log.silly(`Sending ${receiveBuffer.length} bytes to client`);
                        client.write(receiveBuffer);
                        receiveBuffer = undefined;
                    }
                }, 100);
            });
        });
        this.proxyServer.on('listening', () => {
            const port = (this.proxyServer?.address() as AddressInfo).port;
            this.log.info(`Proxy listening on port ${port}`);
            this.createLuxtronikConnection(localhost, port);
        });
        this.proxyServer.listen(undefined, localhost);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            this.closing = true;
            if (this.wsRefreshTimeout) {
                clearTimeout(this.wsRefreshTimeout);
            }
            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }

            this.webSocket?.close();

            this.proxyServer?.close();

            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     */
    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) {
            return;
        }

        // The state was changed from the outside
        this.log.debug(`state ${id} changed: ${JSON.stringify(state.val)}`);
        const idParts = id.split('.');
        idParts.shift(); // remove adapter name
        idParts.shift(); // remove instance number

        const luxSection = luxMeta[idParts[0]];
        if (luxSection && luxSection[idParts[1]]) {
            const meta = luxSection[idParts[1]];
            if (!meta.writeName) {
                return;
            }

            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }
            this.log.debug(`Setting ${meta.writeName} to ${state.val}`);
            this.luxtronik?.write(meta.writeName, state.val, (err: any, _result: any) => {
                if (err) {
                    this.log.error(`Coudln't set ${id}: ${err}`);
                }
                this.requestLuxtronikData();
            });
            return;
        }

        this.requestedUpdates.push({ id: idParts.join('.'), value: state.val as string | number });
        if (this.requestedUpdates.length === 1) {
            this.handleNextUpdate();
        }
    }

    private async handleLuxtronikDataAsync(data: Record<string, Record<string, string | number>>): Promise<void> {
        try {
            for (const sectionName in data) {
                if (!luxMeta[sectionName]) {
                    continue;
                }
                const section = data[sectionName];
                for (const itemName in section) {
                    const meta = luxMeta[sectionName][itemName];
                    if (!meta) {
                        continue;
                    }

                    const value = section[itemName];
                    let stateValue: string | number | boolean | undefined;
                    if (meta.type === 'number') {
                        stateValue = value === 'no' ? undefined : value;
                    } else if (meta.type === 'boolean') {
                        switch (value) {
                            case 'on':
                                stateValue = true;
                                break;
                            case 'off':
                                stateValue = false;
                                break;
                            default:
                                stateValue = undefined;
                                break;
                        }
                    } else {
                        stateValue = value;
                    }
                    await this.setStateValueAsync(`${sectionName}.${itemName}`, stateValue);
                }
            }
        } finally {
            this.luxRefreshTimeout = setTimeout(() => this.requestLuxtronikData(), this.config.refreshInterval * 1000);
        }
    }

    private handleNextUpdate(): boolean {
        if (this.requestedUpdates.length === 0) {
            return false;
        }

        const id = this.requestedUpdates[0].id;
        const idParts = id.split('.');

        const navigationSection = this.navigationSections.findIndex((i) => this.getItemId(i) === idParts[0]);
        if (navigationSection === -1) {
            this.requestedUpdates.shift();
            this.log.warn(`Section not found for state ${id}`);
            return this.handleNextUpdate();
        }

        // request the section so we have the right id to update
        if (this.wsRefreshTimeout) {
            clearTimeout(this.wsRefreshTimeout);
        }
        this.currentNavigationSection = navigationSection - 1;
        this.requestNextContent();
        return true;
    }

    private handleWsMessage(message: string): void {
        this.handleWsMessageAsync(message).catch((error: Error) =>
            this.log.error(`Couldn't handle message: ${error} ${error.stack}`),
        );
    }

    private async handleWsMessageAsync(msg: string): Promise<void> {
        const message: Message = await parseStringPromise(msg);
        this.log.debug(JSON.stringify(message));

        if ('Navigation' in message) {
            if (this.navigationSections.length > 0) {
                return;
            }
            // Reply to the REFRESH command, gives us the structure but no actual data
            for (let i = 0; i < message.Navigation.item.length && i < 2; i++) {
                // only look at the first two items ("Informationen" and "Einstellungen")
                const item = message.Navigation.item[i];
                await this.extendObjectAsync(this.getItemId(item), {
                    type: 'device',
                    common: {
                        name: item.name[0],
                    },
                    native: item as any,
                });
                this.navigationSections.push(item);
            }

            this.requestAllContent();
        } else if ('Content' in message) {
            if (this.isSaving) {
                // the SAVE command gives us the latest "Content", thus we need to ignore this message
                this.isSaving = false;
                if (!this.handleNextUpdate()) {
                    this.requestAllContent();
                }
                return;
            }

            const navigationItem = this.navigationSections[this.currentNavigationSection];
            const navigationId = this.getItemId(navigationItem);
            const sectionIds: string[] = [];
            let shouldSave = false;
            for (let i = 0; i < message.Content.item.length; i++) {
                const section = message.Content.item[i];
                const sectionHandler = this.createHandler(section, navigationId, sectionIds, this);
                if (!this.handlers[sectionHandler.id]) {
                    this.handlers[sectionHandler.id] = sectionHandler;
                    await sectionHandler.extendObjectAsync();
                }

                const itemIds: string[] = [];

                for (let j = 0; j < section.item.length; j++) {
                    const item = section.item[j];
                    const itemHandler = this.createHandler(item, sectionHandler.id, itemIds, this);
                    if (!this.handlers[itemHandler.id]) {
                        this.handlers[itemHandler.id] = itemHandler;
                        this.log.silly(`Creating ${itemHandler.id}`);
                        await itemHandler.extendObjectAsync();
                    }

                    if (this.requestedUpdates.length === 0) {
                        this.log.silly(`Setting state of ${itemHandler.id}`);
                        await itemHandler.setStateAsync();
                    } else {
                        const updateIndex = this.requestedUpdates.findIndex((ch) => ch.id === itemHandler.id);
                        if (updateIndex >= 0) {
                            const cmd = itemHandler.createSetCommand(this.requestedUpdates[updateIndex].value);
                            this.log.debug(`Sending ${cmd}`);
                            this.webSocket?.send(cmd);
                            this.requestedUpdates.splice(updateIndex);
                            shouldSave = true;
                        }
                    }
                }
            }

            if (shouldSave) {
                this.log.debug('Saving');
                this.webSocket?.send('SAVE;1');
                this.isSaving = true;
            } else {
                this.requestNextContent();
            }
        }
    }

    private requestAllContent(): void {
        this.currentNavigationSection = -1;
        this.requestNextContent();
    }

    private requestNextContent(): void {
        this.currentNavigationSection++;
        if (this.currentNavigationSection >= this.navigationSections.length) {
            this.wsRefreshTimeout = setTimeout(() => this.requestAllContent(), this.config.refreshInterval * 1000);
            return;
        }

        const id = this.navigationSections[this.currentNavigationSection].$.id;
        this.log.debug('Getting ' + id);
        this.webSocket?.send('GET;' + id);
    }

    private getItemId(item: ItemBase): string {
        return item.name[0].replace(/[\][*,;'"`<>\\?/._ \-]+/g, '-').replace(/(^-+|-+$)/g, '');
    }

    private createHandler(
        item: ContentSection | ContentItem,
        parentId: string,
        existingIds: string[],
        adapter: Luxtronik2,
    ): ItemHandler<any> {
        const baseId = `${parentId}.${this.getItemId(item)}`;
        let id = baseId;
        for (let i = 1; existingIds.includes(id); i++) {
            id = `${baseId}_${i}`;
        }
        existingIds.push(id);
        if ('item' in item) {
            return new SectionHandler(id, item, adapter);
        }

        if ('option' in item) {
            return new SelectHandler(id, item, adapter);
        }

        if ('min' in item) {
            return new NumberHandler(id, item, adapter);
        }

        return new ReadOnlyHandler(id, item, adapter);
    }

    public async setStateValueAsync(id: string, value: string | number | boolean | undefined): Promise<void> {
        const currentState = await this.getStateAsync(id);
        if (value === undefined) {
            if (currentState) {
                await this.delStateAsync(id);
            }
            return;
        }
        if (!currentState || currentState.val !== value || !currentState.ack) {
            await this.setStateAsync(id, value, true);
        }
    }
}

abstract class ItemHandler<T extends ContentSection | ContentItem> {
    constructor(
        public readonly id: string,
        protected readonly item: Readonly<T>,
        protected readonly adapter: Luxtronik2,
    ) {}

    abstract extendObjectAsync(): Promise<void>;

    abstract setStateAsync(): Promise<void>;

    abstract createSetCommand(value: string | number): string;

    protected unit2role(unit: string | undefined, readOnly: boolean): string {
        const kind = readOnly ? 'value' : 'level';
        switch (unit) {
            case '°C':
            case 'K':
                return `${kind}.temperature`;
            case 'bar':
                return `${kind}.pressure`;
            case 'V':
                return `${kind}.voltage`;
            case 'kWh':
                return `${kind}.power.consumption`;
            case 'kW':
                return `${kind}.power`;
            default:
                return kind;
        }
    }
}

class SectionHandler extends ItemHandler<ContentSection> {
    async extendObjectAsync(): Promise<void> {
        await this.adapter.extendObjectAsync(this.id, {
            type: 'channel',
            common: {
                name: this.item.name[0],
            },
            native: this.item as any,
        });
    }
    setStateAsync(): Promise<void> {
        throw new Error('setStateAsync() not supported on section.');
    }
    createSetCommand(_value: string | number): string {
        throw new Error('createSetCommand() not supported on section.');
    }
}

class ReadOnlyHandler extends ItemHandler<ReadOnlyContentItem> {
    private readonly numberUnitMatch = /^(-?\d+(\.\d+)?|-+) ?(\D*)$/;
    async extendObjectAsync(): Promise<void> {
        const common: Partial<ioBroker.StateCommon> = {
            name: this.item.name[0],
            read: true,
            write: false,
        };
        const value = this.item.value[0];
        const match = value.match(this.numberUnitMatch);
        if (match) {
            common.type = 'number';
            if (match[3]) {
                common.unit = match[3];
            }
            common.role = this.unit2role(common.unit, true);
        } else if (value === 'Ein' || value === 'Aus' || value === 'On' || value === 'Off') {
            common.type = 'boolean';
            common.role = 'sensor';
        } else {
            common.type = 'string';
            common.role = 'text';
        }
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: common,
            native: this.item as any,
        });
    }

    async setStateAsync(): Promise<void> {
        const value = this.item.value[0];
        const match = value.match(this.numberUnitMatch);
        if (match) {
            const numberValue = match[1];
            if (numberValue.endsWith('-')) {
                // something like '---'
                await this.adapter.setStateValueAsync(this.id, undefined);
            } else {
                await this.adapter.setStateValueAsync(this.id, parseFloat(numberValue));
            }
        } else if (value === 'Ein' || value === 'Aus' || value === 'On' || value === 'Off') {
            const flag = value === 'Ein' || value === 'On';
            await this.adapter.setStateValueAsync(this.id, flag);
        } else {
            await this.adapter.setStateValueAsync(this.id, value);
        }
    }

    createSetCommand(_value: string | number): string {
        throw new Error('createSetCommand() not supported on read-only value.');
    }
}

class SelectHandler extends ItemHandler<SelectContentItem> {
    async extendObjectAsync(): Promise<void> {
        const states: Record<string, string> = {};
        this.item.option.forEach((option) => (states[option.$.value] = option._));
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: {
                name: this.item.name[0],
                read: true,
                write: true,
                type: 'string',
                role: 'text',
                states: states,
            },
            native: this.item as any,
        });
        this.adapter.subscribeStates(this.id);
    }

    async setStateAsync(): Promise<void> {
        const value = this.item.raw[0];
        await this.adapter.setStateValueAsync(this.id, value);
    }

    createSetCommand(value: string | number): string {
        return `SET;set_${this.item.$.id};${value}`;
    }
}

class NumberHandler extends ItemHandler<NumberContentItem> {
    async extendObjectAsync(): Promise<void> {
        const unit = this.item.unit[0].trim();
        const min = parseInt(this.item.min[0]);
        const max = parseInt(this.item.max[0]);
        const div = parseInt(this.item.div[0]);
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: {
                name: this.item.name[0],
                read: true,
                write: true,
                type: 'number',
                role: this.unit2role(unit, false),
                unit: unit,
                min: min / div,
                max: max / div,
            },
            native: this.item as any,
        });
        this.adapter.subscribeStates(this.id);
    }

    async setStateAsync(): Promise<void> {
        const div = parseInt(this.item.div[0]);
        const raw = parseInt(this.item.raw[0]);
        await this.adapter.setStateValueAsync(this.id, raw / div);
    }

    createSetCommand(value: string | number): string {
        if (typeof value === 'number') {
            const div = parseInt(this.item.div[0]);
            const min = parseInt(this.item.min[0]);
            const max = parseInt(this.item.max[0]);
            let setValue = Math.round(value * div);
            setValue = Math.max(setValue, min);
            setValue = Math.min(setValue, max);
            return `SET;set_${this.item.$.id};${setValue}`;
        }

        throw new Error('createSetCommand() supports only number value.');
    }
}

if (module.parent) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Luxtronik2(options);
} else {
    // otherwise start the instance directly
    (() => new Luxtronik2())();
}
