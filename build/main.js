"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/*
 * Created with @iobroker/create-adapter v1.30.1
 */
const utils = __importStar(require("@iobroker/adapter-core"));
const luxtronik2_1 = __importDefault(require("luxtronik2"));
const net_1 = require("net");
const ws_1 = __importDefault(require("ws"));
const xml2js_1 = require("xml2js");
const lux_meta_1 = require("./lux-meta");
class Luxtronik2 extends utils.Adapter {
    constructor(options = {}) {
        super({
            dirname: __dirname.indexOf('node_modules') !== -1 ? undefined : __dirname + '/../',
            ...options,
            name: 'luxtronik2',
        });
        this.closing = false;
        this.navigationSections = [];
        this.currentNavigationSection = 0;
        this.handlers = {};
        this.requestedUpdates = [];
        this.isSaving = false;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);
        this.createWebSocket();
        if (this.config.useLuxProxy) {
            await this.createLuxTreeAsync();
            this.createLuxtronikProxy();
        }
        else if (this.config.luxPort) {
            await this.createLuxTreeAsync();
            this.createLuxtronikConnection(this.config.host, this.config.luxPort);
        }
    }
    createWebSocket() {
        if (!this.config.port) {
            return;
        }
        const uri = `ws://${this.config.host}:${this.config.port}`;
        const login = `LOGIN;${this.config.password}`;
        this.webSocket = new ws_1.default(uri, 'Lux_WS');
        this.log.info('Connecting to ' + uri);
        this.webSocket.on('open', () => {
            var _a, _b, _c;
            try {
                this.log.info('Connected to ' + uri);
                (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.send(login);
                (_b = this.webSocket) === null || _b === void 0 ? void 0 : _b.send('REFRESH');
                this.setState('info.connection', true, true);
            }
            catch (e) {
                this.log.error(`Couldn't send login, ${e}`);
                (_c = this.webSocket) === null || _c === void 0 ? void 0 : _c.close();
            }
        });
        this.webSocket.on('message', (msg) => this.handleWsMessage(msg));
        this.webSocket.on('error', (err) => {
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
    async createLuxTreeAsync() {
        for (const sectionName in lux_meta_1.luxMeta) {
            const section = lux_meta_1.luxMeta[sectionName];
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
    createLuxtronikConnection(host, port) {
        if (!port) {
            return;
        }
        this.log.info(`Connecting to ${host}:${port}`);
        this.luxtronik = new luxtronik2_1.default.createConnection(host, port);
        this.requestLuxtronikData();
    }
    requestLuxtronikData() {
        this.luxtronik.read((err, data) => {
            if (err) {
                this.log.error(`Luxtronik read error: ${err}`);
                this.luxRefreshTimeout = setTimeout(() => this.requestLuxtronikData(), this.config.refreshInterval * 1000);
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
    createLuxtronikProxy() {
        const localhost = '127.0.0.1';
        this.proxyServer = net_1.createServer((client) => {
            this.log.debug('Received proxy connect');
            const forward = net_1.createConnection(this.config.luxPort, this.config.host);
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
            let receiveBuffer;
            let receiveTimeout;
            forward.on('data', (data) => {
                this.log.silly(`Received ${data.length} bytes from Luxtronik`);
                if (receiveTimeout) {
                    clearTimeout(receiveTimeout);
                }
                if (receiveBuffer) {
                    receiveBuffer = Buffer.concat([receiveBuffer, data]);
                }
                else {
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
            var _a;
            const port = ((_a = this.proxyServer) === null || _a === void 0 ? void 0 : _a.address()).port;
            this.log.info(`Proxy listening on port ${port}`);
            this.createLuxtronikConnection(localhost, port);
        });
        this.proxyServer.listen(undefined, localhost);
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        var _a, _b;
        try {
            this.closing = true;
            if (this.wsRefreshTimeout) {
                clearTimeout(this.wsRefreshTimeout);
            }
            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }
            (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.close();
            (_b = this.proxyServer) === null || _b === void 0 ? void 0 : _b.close();
            callback();
        }
        catch (e) {
            callback();
        }
    }
    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        var _a;
        if (!state || state.ack) {
            return;
        }
        // The state was changed from the outside
        this.log.debug(`state ${id} changed: ${JSON.stringify(state.val)}`);
        const idParts = id.split('.');
        idParts.shift(); // remove adapter name
        idParts.shift(); // remove instance number
        const luxSection = lux_meta_1.luxMeta[idParts[0]];
        if (luxSection && luxSection[idParts[1]]) {
            const meta = luxSection[idParts[1]];
            if (!meta.writeName) {
                return;
            }
            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }
            this.log.debug(`Setting ${meta.writeName} to ${state.val}`);
            (_a = this.luxtronik) === null || _a === void 0 ? void 0 : _a.write(meta.writeName, state.val, (err, _result) => {
                if (err) {
                    this.log.error(`Coudln't set ${id}: ${err}`);
                }
                this.requestLuxtronikData();
            });
            return;
        }
        this.requestedUpdates.push({ id: idParts.join('.'), value: state.val });
        if (this.requestedUpdates.length === 1) {
            this.handleNextUpdate();
        }
    }
    async handleLuxtronikDataAsync(data) {
        try {
            for (const sectionName in data) {
                if (!lux_meta_1.luxMeta[sectionName]) {
                    continue;
                }
                const section = data[sectionName];
                for (const itemName in section) {
                    const meta = lux_meta_1.luxMeta[sectionName][itemName];
                    if (!meta) {
                        continue;
                    }
                    const value = section[itemName];
                    let stateValue;
                    if (meta.type === 'number') {
                        stateValue = value === 'no' ? undefined : value;
                    }
                    else if (meta.type === 'boolean') {
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
                    }
                    else {
                        stateValue = value;
                    }
                    await this.setStateValueAsync(`${sectionName}.${itemName}`, stateValue);
                }
            }
        }
        finally {
            this.luxRefreshTimeout = setTimeout(() => this.requestLuxtronikData(), this.config.refreshInterval * 1000);
        }
    }
    handleNextUpdate() {
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
    handleWsMessage(message) {
        this.handleWsMessageAsync(message).catch((error) => this.log.error(`Couldn't handle message: ${error} ${error.stack}`));
    }
    async handleWsMessageAsync(msg) {
        var _a, _b;
        const message = await xml2js_1.parseStringPromise(msg);
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
                    native: item,
                });
                this.navigationSections.push(item);
            }
            this.requestAllContent();
        }
        else if ('Content' in message) {
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
            const sectionIds = [];
            let shouldSave = false;
            for (let i = 0; i < message.Content.item.length; i++) {
                const section = message.Content.item[i];
                const sectionHandler = this.createHandler(section, navigationId, sectionIds, this);
                if (!sectionHandler) {
                    continue;
                }
                if (!this.handlers[sectionHandler.id]) {
                    this.handlers[sectionHandler.id] = sectionHandler;
                    await sectionHandler.extendObjectAsync();
                }
                const itemIds = [];
                for (let j = 0; j < section.item.length; j++) {
                    const item = section.item[j];
                    try {
                        const itemHandler = this.createHandler(item, sectionHandler.id, itemIds, this);
                        if (!itemHandler) {
                            continue;
                        }
                        if (!this.handlers[itemHandler.id]) {
                            this.log.silly(`Creating ${itemHandler.id}`);
                            await itemHandler.extendObjectAsync();
                            this.handlers[itemHandler.id] = itemHandler;
                        }
                        if (this.requestedUpdates.length === 0) {
                            this.log.silly(`Setting state of ${itemHandler.id}`);
                            await itemHandler.setStateAsync();
                        }
                        else {
                            const updateIndex = this.requestedUpdates.findIndex((ch) => ch.id === itemHandler.id);
                            if (updateIndex >= 0) {
                                const cmd = itemHandler.createSetCommand(this.requestedUpdates[updateIndex].value);
                                this.log.debug(`Sending ${cmd}`);
                                (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.send(cmd);
                                this.requestedUpdates.splice(updateIndex);
                                shouldSave = true;
                            }
                        }
                    }
                    catch (error) {
                        this.log.error(`Couldn't handle '${sectionHandler.id}' -> '${item.name[0]}': ${error}`);
                    }
                }
            }
            if (shouldSave) {
                this.log.debug('Saving');
                (_b = this.webSocket) === null || _b === void 0 ? void 0 : _b.send('SAVE;1');
                this.isSaving = true;
            }
            else {
                this.requestNextContent();
            }
        }
    }
    requestAllContent() {
        this.currentNavigationSection = -1;
        this.requestNextContent();
    }
    requestNextContent() {
        var _a;
        this.currentNavigationSection++;
        if (this.currentNavigationSection >= this.navigationSections.length) {
            this.wsRefreshTimeout = setTimeout(() => this.requestAllContent(), this.config.refreshInterval * 1000);
            return;
        }
        const id = this.navigationSections[this.currentNavigationSection].$.id;
        this.log.debug('Getting ' + id);
        (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.send('GET;' + id);
    }
    getItemId(item) {
        return item.name[0].replace(/[\][*,;'"`<>\\?/._ \-]+/g, '-').replace(/(^-+|-+$)/g, '');
    }
    createHandler(item, parentId, existingIds, adapter) {
        const baseId = `${parentId}.${this.getItemId(item)}`;
        if (baseId.endsWith('.')) {
            // item has no name
            return undefined;
        }
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
    async setStateValueAsync(id, value) {
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
class ItemHandler {
    constructor(id, item, adapter) {
        this.id = id;
        this.item = item;
        this.adapter = adapter;
    }
    unit2role(unit, readOnly) {
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
class SectionHandler extends ItemHandler {
    async extendObjectAsync() {
        await this.adapter.extendObjectAsync(this.id, {
            type: 'channel',
            common: {
                name: this.item.name[0],
            },
            native: this.item,
        });
    }
    setStateAsync() {
        throw new Error('setStateAsync() not supported on section.');
    }
    createSetCommand(_value) {
        throw new Error('createSetCommand() not supported on section.');
    }
}
class ReadOnlyHandler extends ItemHandler {
    constructor() {
        super(...arguments);
        this.numberUnitMatch = /^(-?\d+(\.\d+)?|-+) ?(\D*)$/;
    }
    async extendObjectAsync() {
        const common = {
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
        }
        else if (value === 'Ein' || value === 'Aus' || value === 'On' || value === 'Off') {
            common.type = 'boolean';
            common.role = 'sensor';
        }
        else {
            common.type = 'string';
            common.role = 'text';
        }
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: common,
            native: this.item,
        });
    }
    async setStateAsync() {
        const value = this.item.value[0];
        const match = value.match(this.numberUnitMatch);
        if (match) {
            const numberValue = match[1];
            if (numberValue.endsWith('-')) {
                // something like '---'
                await this.adapter.setStateValueAsync(this.id, undefined);
            }
            else {
                await this.adapter.setStateValueAsync(this.id, parseFloat(numberValue));
            }
        }
        else if (value === 'Ein' || value === 'Aus' || value === 'On' || value === 'Off') {
            const flag = value === 'Ein' || value === 'On';
            await this.adapter.setStateValueAsync(this.id, flag);
        }
        else {
            await this.adapter.setStateValueAsync(this.id, value);
        }
    }
    createSetCommand(_value) {
        throw new Error('createSetCommand() not supported on read-only value.');
    }
}
class SelectHandler extends ItemHandler {
    async extendObjectAsync() {
        const states = {};
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
            native: this.item,
        });
        this.adapter.subscribeStates(this.id);
    }
    async setStateAsync() {
        const value = this.item.raw[0];
        await this.adapter.setStateValueAsync(this.id, value);
    }
    createSetCommand(value) {
        return `SET;set_${this.item.$.id};${value}`;
    }
}
class NumberHandler extends ItemHandler {
    async extendObjectAsync() {
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
            native: this.item,
        });
        this.adapter.subscribeStates(this.id);
    }
    async setStateAsync() {
        const div = parseInt(this.item.div[0]);
        const raw = parseInt(this.item.raw[0]);
        await this.adapter.setStateValueAsync(this.id, raw / div);
    }
    createSetCommand(value) {
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
    module.exports = (options) => new Luxtronik2(options);
}
else {
    // otherwise start the instance directly
    (() => new Luxtronik2())();
}
