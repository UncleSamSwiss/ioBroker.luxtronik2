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
const SentryNode = __importStar(require("@sentry/node"));
const luxtronik2_1 = __importDefault(require("luxtronik2"));
const ws_1 = __importDefault(require("ws"));
const xml2js_1 = require("xml2js");
const lux_meta_1 = require("./lux-meta");
const WATCHDOG_RETRIES = 3;
class Luxtronik2 extends utils.Adapter {
    constructor(options = {}) {
        super({
            dirname: __dirname.indexOf('node_modules') !== -1 ? undefined : __dirname + '/../',
            ...options,
            name: 'luxtronik2',
        });
        this.wsFailCounter = 0;
        this.luxFailCounter = 0;
        this.closing = false;
        this.navigationSections = [];
        this.currentNavigationSection = 0;
        this.handlers = {};
        this.requestedUpdates = [];
        this.isSaving = false;
        this.reportedUnknownData = new Set();
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
        if (!this.config.host) {
            this.log.error(`No host is configured, will not start anything!`);
            return;
        }
        await this.cleanupObjects();
        this.createWebSocket();
        if (this.config.luxPort) {
            await this.createLuxTreeAsync();
            this.createLuxtronikConnection(this.config.host, this.config.luxPort);
        }
        this.watchdogInterval = setInterval(() => this.handleWatchdog(), this.config.refreshInterval * 1000);
    }
    async cleanupObjects() {
        const allObjects = await this.getAdapterObjectsAsync();
        // remove all timestamp entries that were created befor version 0.2 (Fehlerspeicher and Abschaltungen)
        await Promise.all(Object.keys(allObjects)
            .filter((id) => !!id.match(/\.\d\d-\d\d-\d\d-\d\d:\d\d:\d\d$/))
            .map((id) => this.delForeignObjectAsync(id)));
    }
    createWebSocket() {
        var _a;
        if (!this.config.port) {
            return;
        }
        const uri = `ws://${this.config.host}:${this.config.port}`;
        const login = `LOGIN;${this.config.password}`;
        this.webSocket = new ws_1.default(uri, 'Lux_WS');
        this.log.info('Connecting to ' + uri);
        (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.addBreadcrumb({ type: 'http', category: 'ws', data: { url: uri } });
        this.webSocket.on('open', () => {
            var _a, _b, _c, _d;
            try {
                this.log.info('Connected to ' + uri);
                (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.send(login);
                (_b = this.webSocket) === null || _b === void 0 ? void 0 : _b.send('REFRESH');
                this.setState('info.connection', true, true);
            }
            catch (e) {
                this.log.error(`Couldn't send login, ${e}`);
                (_c = this.getSentry()) === null || _c === void 0 ? void 0 : _c.captureException(e);
                (_d = this.webSocket) === null || _d === void 0 ? void 0 : _d.close();
            }
        });
        this.webSocket.on('message', (msg) => this.handleWsMessage(msg));
        this.webSocket.on('error', (err) => {
            var _a;
            if (this.closing) {
                return;
            }
            this.log.error(`Got WebSocket error ${err}`);
            (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureException(err);
            // not available in unit tests
            if (this.restart) {
                this.restart();
            }
        });
        this.webSocket.on('close', () => {
            var _a;
            if (this.closing) {
                return;
            }
            this.log.error('Got unexpected close event');
            (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureMessage('Got unexpected close event', SentryNode.Severity.Warning);
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
                if (!item) {
                    // ignore it
                    continue;
                }
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
        this.luxFailCounter = 0;
        this.luxtronik.read((err, data) => {
            var _a;
            if (err) {
                if (err.message === 'heatpump busy') {
                    this.log.info('Heatpump busy, will retry later');
                }
                else {
                    this.log.error(`Luxtronik read error, will retry later: ${err}`);
                    (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureException(err);
                }
                this.luxRefreshTimeout = setTimeout(() => this.requestLuxtronikData(), this.config.refreshInterval * 1000);
                return;
            }
            this.setState('info.connection', true, true);
            this.handleLuxtronikDataAsync(data).catch((e) => {
                var _a;
                this.log.error(`Couldn't handle luxtronik data ${e}`);
                (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureException(e);
            });
        });
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback) {
        var _a;
        try {
            this.closing = true;
            clearInterval(this.watchdogInterval);
            if (this.wsRefreshTimeout) {
                clearTimeout(this.wsRefreshTimeout);
            }
            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }
            (_a = this.webSocket) === null || _a === void 0 ? void 0 : _a.close();
            callback();
        }
        catch (e) {
            callback();
        }
    }
    handleWatchdog() {
        var _a, _b;
        if (this.config.port) {
            if (this.wsFailCounter >= WATCHDOG_RETRIES) {
                const msg = `Didn't receive data from WebSocket after ${this.wsFailCounter} retries, restarting adapter`;
                this.log.error(msg);
                (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureMessage(msg, SentryNode.Severity.Error);
                this.restart();
                return;
            }
            this.wsFailCounter++;
        }
        if (this.config.luxPort) {
            if (this.luxFailCounter >= WATCHDOG_RETRIES) {
                const msg = `Didn't receive data from Lux port after ${this.luxFailCounter} retries, restarting adapter`;
                this.log.error(msg);
                (_b = this.getSentry()) === null || _b === void 0 ? void 0 : _b.captureMessage(msg, SentryNode.Severity.Error);
                this.restart();
                return;
            }
            this.luxFailCounter++;
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
            if (!(meta === null || meta === void 0 ? void 0 : meta.writeName)) {
                return;
            }
            if (this.luxRefreshTimeout) {
                clearTimeout(this.luxRefreshTimeout);
            }
            this.log.debug(`Setting ${meta.writeName} to ${state.val}`);
            (_a = this.luxtronik) === null || _a === void 0 ? void 0 : _a.write(meta.writeName, state.val, (err, _result) => {
                var _a;
                if (err) {
                    this.log.error(`Coudln't set ${id}: ${err}`);
                    (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureException(err, { extra: { id } });
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
                const metaSection = lux_meta_1.luxMeta[sectionName];
                const section = data[sectionName];
                if (!metaSection) {
                    const msg = `Unknown section ${sectionName}`;
                    this.log.warn(msg);
                    if (!this.reportedUnknownData.has(msg)) {
                        this.reportedUnknownData.add(msg);
                        const sentry = this.getSentry();
                        sentry === null || sentry === void 0 ? void 0 : sentry.withScope((scope) => {
                            scope.setExtra('section', JSON.stringify(section, null, 2));
                            sentry.captureMessage(msg, SentryNode.Severity.Warning);
                        });
                    }
                    continue;
                }
                for (const itemName in section) {
                    const meta = metaSection[itemName];
                    const value = section[itemName];
                    if (!meta) {
                        if (metaSection.hasOwnProperty(itemName)) {
                            // item was explicitly excluded (set to undefined in the meta-data)
                            continue;
                        }
                        const msg = `Unknown data item ${sectionName}.${itemName}`;
                        this.log.warn(msg);
                        if (!this.reportedUnknownData.has(msg)) {
                            this.reportedUnknownData.add(msg);
                            const sentry = this.getSentry();
                            sentry === null || sentry === void 0 ? void 0 : sentry.withScope((scope) => {
                                scope.setExtra('value', value);
                                sentry.captureMessage(msg, SentryNode.Severity.Warning);
                            });
                        }
                        continue;
                    }
                    let stateValue;
                    if (meta.type === 'number') {
                        stateValue = value === 'no' ? null : value;
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
                                stateValue = null;
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
            const msg = `Section not found for state ${id}`;
            this.log.warn(msg);
            if (!this.reportedUnknownData.has(msg)) {
                this.reportedUnknownData.add(msg);
                const sentry = this.getSentry();
                sentry === null || sentry === void 0 ? void 0 : sentry.withScope((scope) => {
                    scope.setExtra('id', id);
                    sentry.captureMessage(msg, SentryNode.Severity.Warning);
                });
            }
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
        this.handleWsMessageAsync(message).catch((error) => {
            var _a;
            this.log.error(`Couldn't handle message: ${error} ${error.stack}`);
            (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.captureException(error, { extra: { message } });
        });
    }
    async handleWsMessageAsync(msg) {
        var _a, _b, _c, _d, _e;
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
                const sectionHandler = this.createHandler(section, navigationId, sectionIds);
                if (!sectionHandler) {
                    continue;
                }
                if (!this.handlers[sectionHandler.id]) {
                    this.handlers[sectionHandler.id] = sectionHandler;
                    await sectionHandler.extendObjectAsync();
                }
                if (sectionHandler instanceof TimeLogSectionHandler) {
                    // time log sections are actually states
                    await sectionHandler.setStateAsync();
                    continue;
                }
                const itemIds = [];
                for (let j = 0; j < section.item.length; j++) {
                    const item = section.item[j];
                    try {
                        const itemHandler = this.createHandler(item, sectionHandler.id, itemIds);
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
                                (_a = this.getSentry()) === null || _a === void 0 ? void 0 : _a.addBreadcrumb({ type: 'http', category: 'ws', data: { url: cmd } });
                                (_b = this.webSocket) === null || _b === void 0 ? void 0 : _b.send(cmd);
                                this.requestedUpdates.splice(updateIndex);
                                shouldSave = true;
                            }
                        }
                    }
                    catch (error) {
                        this.log.error(`Couldn't handle '${sectionHandler.id}' -> '${item.name[0]}': ${error}`);
                        (_c = this.getSentry()) === null || _c === void 0 ? void 0 : _c.captureException(error, { extra: { section: sectionHandler.id, item } });
                    }
                }
            }
            if (shouldSave) {
                this.log.debug('Saving');
                (_d = this.getSentry()) === null || _d === void 0 ? void 0 : _d.addBreadcrumb({ type: 'http', category: 'ws', data: { url: 'SAVE;1' } });
                (_e = this.webSocket) === null || _e === void 0 ? void 0 : _e.send('SAVE;1');
                this.isSaving = true;
            }
            else {
                this.requestNextContent();
            }
        }
    }
    requestAllContent() {
        this.wsFailCounter = 0;
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
    createHandler(item, parentId, existingIds) {
        const baseId = `${parentId}.${this.getItemId(item)}`;
        if (baseId.endsWith('.')) {
            // item has no name
            const sentry = this.getSentry();
            sentry === null || sentry === void 0 ? void 0 : sentry.withScope((scope) => {
                scope.setExtra('item', JSON.stringify(item, null, 2));
                sentry.captureMessage(`No name for handler: ${baseId}`, SentryNode.Severity.Warning);
            });
            return undefined;
        }
        let id = baseId;
        for (let i = 1; existingIds.includes(id); i++) {
            id = `${baseId}_${i}`;
        }
        existingIds.push(id);
        if ('item' in item) {
            if (item.item.every((i) => i.name.every((n) => !!n.match(/^\d\d\.\d\d\.\d\d \d\d:\d\d:\d\d$/)))) {
                // this is a section with timestamps, use a special handler
                return new TimeLogSectionHandler(id, item, this);
            }
            else {
                return new SectionHandler(id, item, this);
            }
        }
        if ('option' in item) {
            return new SelectHandler(id, item, this);
        }
        if ('min' in item) {
            return new NumberHandler(id, item, this);
        }
        return new ReadOnlyHandler(id, item, this);
    }
    async setStateValueAsync(id, value) {
        await this.setStateChangedAsync(id, value, true);
    }
    getSentry() {
        if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
            const sentryInstance = this.getPluginInstance('sentry');
            if (sentryInstance) {
                return sentryInstance.getSentryObject();
            }
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
class TimeLogSectionHandler extends SectionHandler {
    async extendObjectAsync() {
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: {
                name: this.item.name[0],
                type: 'object',
                role: 'json',
                read: true,
                write: false,
            },
            native: this.item,
        });
    }
    async setStateAsync() {
        const value = this.item.item.reduce((old, item) => ({ ...old, [item.name[0]]: item.value[0] }), {});
        await this.adapter.setStateValueAsync(this.id, JSON.stringify(value));
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
                await this.adapter.setStateValueAsync(this.id, null);
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
        this.item.option.forEach((option) => (states[parseInt(option.$.value)] = option._));
        await this.adapter.extendObjectAsync(this.id, {
            type: 'state',
            common: {
                name: this.item.name[0],
                read: true,
                write: true,
                type: 'number',
                role: 'level',
                states: states,
            },
            native: this.item,
        });
        this.adapter.subscribeStates(this.id);
    }
    async setStateAsync() {
        const value = parseInt(this.item.raw[0]);
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
//# sourceMappingURL=main.js.map