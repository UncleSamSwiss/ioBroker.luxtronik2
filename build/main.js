"use strict";
/*
 * Created with @iobroker/create-adapter v1.30.1
 */
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
// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = __importStar(require("@iobroker/adapter-core"));
const ws_1 = __importDefault(require("ws"));
const xml2js_1 = require("xml2js");
// Load your modules here, e.g.:
// import * as fs from "fs";
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
        // this.on('objectChange', this.onObjectChange.bind(this));
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }
    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here
        // Reset the connection indicator during startup
        this.setState('info.connection', false, true);
        const uri = 'ws://' + this.config.host + ':' + this.config.port;
        const login = 'LOGIN;' + this.config.password;
        this.ws = new ws_1.default(uri, 'Lux_WS');
        this.ws.on('open', () => {
            try {
                this.log.info('Connected to ' + uri);
                this.ws.send(login);
                this.ws.send('REFRESH');
                this.setState('info.connection', true, true);
            }
            catch (e) {
                this.ws.close();
            }
        });
        this.ws.on('message', (msg) => this.handleWsMessage(msg));
        this.ws.on('error', (err) => {
            this.log.error(`Got WebSocket error ${err}`);
            this.restart();
        });
        this.ws.on('close', () => {
            this.log.error('Got unexpected close event');
            this.restart();
        });
        /*
        // The adapters config (in the instance object everything under the attribute "native") is accessible via
        // this.config:
        this.log.info('config option1: ' + this.config.option1);
        this.log.info('config option2: ' + this.config.option2);

        /*
        For every state in the system there has to be also an object of type state
        Here a simple template for a boolean variable named "testVariable"
        Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables
        * /
        await this.setObjectNotExistsAsync('testVariable', {
            type: 'state',
            common: {
                name: 'testVariable',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: true,
            },
            native: {},
        });

        // In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
        this.subscribeStates('testVariable');
        // You can also add a subscription for multiple states. The following line watches all states starting with "lights."
        // this.subscribeStates('lights.*');
        // Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
        // this.subscribeStates('*');

        /*
            setState examples
            you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
        * /
        // the variable testVariable is set to true as command (ack=false)
        await this.setStateAsync('testVariable', true);

        // same thing, but the value is flagged "ack"
        // ack should be always set to true if the value is received from or acknowledged from the target system
        await this.setStateAsync('testVariable', { val: true, ack: true });

        // same thing, but the state is deleted after 30s (getState will return null afterwards)
        await this.setStateAsync('testVariable', { val: true, ack: true, expire: 30 });

        // examples for the checkPassword/checkGroup functions
        let result = await this.checkPasswordAsync('admin', 'iobroker');
        this.log.info('check user admin pw iobroker: ' + result);

        result = await this.checkGroupAsync('admin', 'admin');
        this.log.info('check group user admin group admin: ' + result);*/
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        try {
            this.closing = true;
            if (this.refreshTimeout) {
                clearTimeout(this.refreshTimeout);
            }
            this.ws.close();
            callback();
        }
        catch (e) {
            callback();
        }
    }
    // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
    // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
    // /**
    //  * Is called if a subscribed object changes
    //  */
    // private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
    //     if (obj) {
    //         // The object was changed
    //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
    //     } else {
    //         // The object was deleted
    //         this.log.info(`object ${id} deleted`);
    //     }
    // }
    /**
     * Is called if a subscribed state changes
     */
    onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        // The state was changed from the outside
        this.log.debug(`state ${id} changed: ${state.val}`);
        const idParts = id.split('.');
        idParts.shift(); // remove adapter name
        idParts.shift(); // remove instance number
        this.requestedUpdates.push({ id: idParts.join('.'), value: state.val });
        if (this.requestedUpdates.length === 1) {
            this.handleNextUpdate();
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
        if (this.refreshTimeout) {
            clearTimeout(this.refreshTimeout);
        }
        this.currentNavigationSection = navigationSection - 1;
        this.requestNextContent();
        return true;
    }
    handleWsMessage(message) {
        this.handleWsMessageAsync(message).catch((error) => this.log.error(`Couldn't handle message: ${error} ${error.stack}`));
    }
    async handleWsMessageAsync(msg) {
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
                if (!this.handlers[sectionHandler.id]) {
                    this.handlers[sectionHandler.id] = sectionHandler;
                    await sectionHandler.extendObjectAsync();
                }
                const itemIds = [];
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
                    }
                    else {
                        const updateIndex = this.requestedUpdates.findIndex((ch) => ch.id === itemHandler.id);
                        if (updateIndex >= 0) {
                            const cmd = itemHandler.createSetCommand(this.requestedUpdates[updateIndex].value);
                            this.log.debug(`Sending ${cmd}`);
                            this.ws.send(cmd);
                            this.requestedUpdates.splice(updateIndex);
                            shouldSave = true;
                        }
                    }
                }
                if (shouldSave) {
                    this.log.debug('Saving');
                    this.ws.send('SAVE;1');
                    this.isSaving = true;
                    return;
                }
            }
            this.requestNextContent();
        }
    }
    requestAllContent() {
        this.currentNavigationSection = -1;
        this.requestNextContent();
    }
    requestNextContent() {
        this.currentNavigationSection++;
        if (this.currentNavigationSection >= this.navigationSections.length) {
            this.refreshTimeout = setTimeout(() => this.requestAllContent(), this.config.refreshInterval * 1000);
            return;
        }
        const id = this.navigationSections[this.currentNavigationSection].$.id;
        this.log.debug('Getting ' + id);
        this.ws.send('GET;' + id);
    }
    getItemId(item) {
        return item.name[0].replace(/[\][*,;'"`<>\\?/._ \-]+/g, '-').replace(/(^-+|-+$)/g, '');
    }
    createHandler(item, parentId, existingIds, adapter) {
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
}
class ItemHandler {
    constructor(id, item, adapter) {
        this.id = id;
        this.item = item;
        this.adapter = adapter;
    }
    unit2role(unit) {
        switch (unit) {
            case '°C':
            case 'K':
                return 'value.temperature';
            case 'bar':
                return 'value.pressure';
            case 'V':
                return 'value.voltage';
            case 'kWh':
                return 'value.power.consumption';
            case 'kW':
                return 'value.power';
            default:
                return 'value';
        }
    }
    async setStateValueAsync(value) {
        const currentState = await this.adapter.getStateAsync(this.id);
        if (!currentState || currentState.val !== value || !currentState.ack) {
            await this.adapter.setStateAsync(this.id, value, true);
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
            common.role = this.unit2role(common.unit);
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
                await this.setStateValueAsync(null);
            }
            else {
                await this.setStateValueAsync(parseFloat(numberValue));
            }
        }
        else if (value === 'Ein' || value === 'Aus' || value === 'On' || value === 'Off') {
            const flag = value === 'Ein' || value === 'On';
            await this.setStateValueAsync(flag);
        }
        else {
            await this.setStateValueAsync(value);
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
        await this.setStateValueAsync(value);
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
                role: this.unit2role(unit),
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
        await this.setStateValueAsync(raw / div);
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
