'use strict'

var req = require('tiny_request')
var fs = require('fs');
var assign = require('lodash/assign');
var compact = require('lodash/compact');
var find = require('lodash/find');
var get = require('lodash/get');
var forEach = require('lodash/forEach');
var map = require('lodash/map');
var includes = require('lodash/includes');
var isArray = require('lodash/isArray');
var isString = require('lodash/isString');
var isFunction = require('lodash/isFunction');
var flattenDeep = require('lodash/flattenDeep');

Promise.prototype.finally = function (callback) {
    let p = this.constructor;
    return this.then(
        value  => p.resolve(callback()).then(() => value),
        reason => p.resolve(callback()).then(() => { throw reason })
    );
};

class tgBot {
    constructor(token, options) {
        this._token = token;
        this._url = 'https://api.telegram.org/bot' + this._token + '/';
        this._options = options || {};
        this._beforeUpdate = null;
        this._beforeCommand = null;
        this._beforeText = null;
        this._onAllText = null;
        this._commands = {};
        this._textCommands = {};
        this._waitingCallbacks = {};
        this._callbackQueriesCallbacks = {};
        this._scopeFunctions = [
            'sendMessage', 'forwardMessage', 'sendChatAction', 'sendLocation', 'sendVenue', 'sendContact',
            'editChatMessageText', 'editChatMessageCaption', 'editChatMessageReplyMarkup',
            'waitForMessage', 'sendMenu', 'sendForm', 'sendMessageWithInlineKeyboard', 'sendVenueWithInlineKeyboard',
            'sendLocationWithInlineKeyboard'
        ];

        if (!fs.existsSync(__dirname + '/tmp')) {
            fs.mkdirSync(__dirname + '/tmp')
        }

        this._initPolling();
    }

    /* Private methods */

    /**
     * Execute some api method
     * @param {String} method - some api method
     * @param {Object} params - query params
     * @return {Promise}
     * @private
     */
    _api(method, params) {
        return new Promise((resolve, reject) => {
            req.post({
                url: this._url + method,
                form: params,
                json: true
            }, (body, res, err) => {
                if (err || !body.ok) {
                    reject(err || body.description);
                }

                if (res.statusCode === 200) {
                    resolve(body.result);
                }
            });
        });
    }

    /**
     * Init polling mode
     */
    _initPolling() {
        this._polling = {
            timeout: this._options.timeout || 50,
            offset: 0
        };

        this._startPolling();
    }

    /**
     * Start getting updates using long polling
     */
    _startPolling() {
        this._getUpdates().then((updates) => {
            updates.forEach((update) => {
                let scope = this._createScope(update);

                this._beforeUpdate ?
                    this._beforeUpdate(scope, () => this._processUpdate(update, scope)) :
                    this._processUpdate(update, scope);
            });
        });
    }

    /**
     * Receive incoming updates using long polling
     * @see https://core.telegram.org/bots/api#getupdates
     */
    _getUpdates() {
        return this._api('getUpdates', {
            timeout: this._polling.timeout,
            offset: this._polling.offset
        }).then((res) => {
            if (res && res.length) {
                this._polling.offset = res[res.length - 1].update_id + 1;
            }

            return res;
        }).finally(() => {
            this._startPolling();
        });
    }

    /**
     * Check if the text is a command
     * @param {String} text - text message
     * @private
     */
    _isCommand(text) {
        if (!text) return;
        return text.indexOf('/') === 0;
    }

    /**
     * Create scope for command
     * @param {Object} message - message from telegram
     * @return {Object}
     * @private
     */
    _createScope(update) {
        let msgObject, chatId, user;
        let scope = {};

        if (update.message) {
            scope.chatId = get(update.message, 'chat.id') || get(update.message, 'from.id');
            scope.user = update.message.from;
            scope.message = update.message;
            scope.goTo = (command) => {
                this._waitingCallbacks[scope.chatId] = null;
                scope.message.text = command;
                this._processMessage(scope);
            };
        } else if (update.callback_query) {
            scope.chatId = get(update.callback_query, 'message.chat.id') || get(update.callback_query, 'message.from.id');
            scope.user = update.callback_query.from;
            scope.message = update.callback_query.message;
            scope.answer = this.answerCallbackQuery.bind(this, update.callback_query.id);
            scope.data = update.callback_query.data;
            scope.clearCallback = () => {
                delete this._callbackQueriesCallbacks[scope.user.id + ':' + scope.data];
            };
            scope.goTo = (command) => {
                this._waitingCallbacks[scope.chatId] = null;
                scope.message = { text: command };
                this._processMessage(scope);
            };
        }

        this._scopeFunctions.forEach((func) => {
            scope[func] = this[func].bind(this, scope.chatId);
        });

        return scope;
    }

    /**
     * Process update of any kind
     * @param {Object} update - update from telegram
     * @param {Object} scope - created scope from update
     * @private
     */
    _processUpdate(update, scope) {
        if (update.message) {
            this._processMessage(scope);
        } else if (update.callback_query) {
            this._processCallbackQuery(scope);
        }
    }

    /**
     * Process incoming message
     * @param {Object} message - message from telegram
     * @private
     */
    _processMessage(scope) {
        let text = scope.message.text;

        if (text) {
            // process message as a command
            if (this._isCommand(text)) {
                let command = this._prepareCommand(text);

                if (command) {
                    scope.params = command.params;
                    this._beforeCommand ?
                        this._beforeCommand(scope, () => command.callback(scope)) :
                        command.callback(scope);
                }
            } else {
                // process message as a text
                let textCommand = this._prepareText(text);

                if (this._beforeText) {
                    this._beforeText(scope, () => {
                        this._onAllText && this._onAllText(scope);
                        textCommand && textCommand(scope);
                    });
                } else {
                    this._onAllText && this._onAllText(scope);
                    textCommand && textCommand(scope);
                }
            }
        }

        if (!this._isCommand(text)) {
            let waitingCallback = this._waitingCallbacks[scope.chatId];

            if (waitingCallback) {
                waitingCallback(scope);

                if (waitingCallback === this._waitingCallbacks[scope.chatId]) {
                    delete this._waitingCallbacks[scope.chatId];
                }
            }
        }
    }

    /**
     * Process incoming callback query from a callback button in an inline keyboard
     * @param {Object} cbQuery - callback query
     * @private
     */
    _processCallbackQuery(scope) {
        let callback = this._callbackQueriesCallbacks[scope.user.id + ':' + scope.data];

        if (callback) {
            callback(scope);
        } else if (this._onEmptyCallbackQuery) {
            this._onEmptyCallbackQuery(scope);
        }
    }

    /**
     * Prepare command for usage
     * @param {String} command - command string
     * @return {Object}
     * @private
     */
    _prepareCommand(command) {
        command = command.replace('/', '');

        let parsedCommand = compact(command.split(' '));
        let commandName = parsedCommand[0];
        let existedCommand = this._commands[commandName];
        let resCommand = {};

        if (!existedCommand) {
            return;
        }

        resCommand.name = commandName;
        resCommand.callback = existedCommand.callback;

        // If we have masked command with query params
        if (existedCommand.params) {
            resCommand.params = {};

            let queryParams = parsedCommand.slice(1);

            if (queryParams.length) {
                queryParams.forEach((param, i) => {
                    let existedParam = existedCommand.params[i];
                    existedParam && (resCommand.params[existedParam] = param);
                });
            }
        }

        return resCommand;
    }

    /**
     * Prepare text command for usage
     * @param {String} text - text from message
     * @return {String}
     * @private
     */
    _prepareText(text) {
        return this._textCommands[text];
    }

    /**
     * Prepare options for message
     * @param {Object} options - additional options for message
     * @param {Object} params - required options for message
     * @return {Object}
     * @private
     */
    _prepareOptions(options, params) {
        options = options || {};

        forEach(options, (option, key) => {
            if (key === 'reply_markup') {
                option = option ? JSON.stringify(option) : '';
            }

            options[key] = option;
        });

        assign(options, params);

        return options;
    }

    /* API methods */

    /**
     * Returns basic information about the bot
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendmessage
     */
    getMe() {
        return this._api('getMe');
    }

    /**
     * Send text message
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {String} text - text of the message to be sent
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendmessage
     */
    sendMessage(chatId, text, options) {
        return this._api('sendMessage', this._prepareOptions(options, {
            chat_id: chatId,
            text: text
        }));
    }

    /**
     * Send text message with inline keyboard
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {String} text - text of the message to be sent
     * @param {Object} keyboard - inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendmessage
     */
    sendMessageWithInlineKeyboard(chatId, text, keyboard, options) {
        options = options || {};

        options.reply_markup = {
            inline_keyboard: this.buildInlineKeyboard(chatId, keyboard)
        };

        return this.sendMessage(chatId, text, options);
    }

    /**
     * Forward messages of any kind
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Number|String} fromChatId - unique identifier for the chat where the original message was sent
     * @param {Number|String} messageId - unique message identifier
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#forwardmessage
     */
    forwardMessage(chatId, fromChatId, messageId) {
        return this._api('forwardMessage', {
            chat_id: chatId,
            from_chat_id: fromChatId,
            message_id: messageId
        });
    }

    /**
     * Send chat action
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {String} action - type of action to broadcast.
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendchataction
     */
    sendChatAction(chatId, action) {
        return this._api('sendChatAction', {
            chat_id: chatId,
            action: action
        });
    }

    /**
     * Send point on the map
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Float} latitude - latitude of location
     * @param {Float} longitude - longitude of location
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendlocation
     */
    sendLocation(chatId, latitude, longitude, options) {
        return this._api('sendLocation', this._prepareOptions(options, {
            chat_id: chatId,
            latitude: latitude,
            longitude: longitude
        }));
    }

    /**
     * Send point on the map
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Float} latitude - latitude of location
     * @param {Float} longitude - longitude of location
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendlocation
     */
    sendLocation(chatId, latitude, longitude, options) {
        return this._api('sendLocation', this._prepareOptions(options, {
            chat_id: chatId,
            latitude: latitude,
            longitude: longitude
        }));
    }

    /**
     * Send point on the map with inline keyboard
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Float} latitude - latitude of location
     * @param {Float} longitude - longitude of location
     * @param {Object} keyboard - inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendlocation
     */
    sendLocationWithInlineKeyboard(chatId, latitude, longitude, keyboard, options) {
        options = options || {};

        options.reply_markup = {
            inline_keyboard: this.buildInlineKeyboard(chatId, keyboard)
        };

        return this.sendLocation(chatId, latitude, longitude, options);
    }

    /**
     * Send point on the map
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Float} latitude - latitude of location
     * @param {Float} longitude - longitude of location
     * @param {String} title - name of the venue
     * @param {String} address - address of the venue
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendvenue
     */
    sendVenue(chatId, latitude, longitude, title, address, options) {
        return this._api('sendVenue', this._prepareOptions(options, {
            chat_id: chatId,
            latitude: latitude,
            longitude: longitude,
            title: title,
            address: address
        }));
    }

    /**
     * Send point on the map with inline keyboard
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Float} latitude - latitude of location
     * @param {Float} longitude - longitude of location
     * @param {String} title - name of the venue
     * @param {String} address - address of the venue
     * @param {Object} keyboard - inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendvenue
     */
    sendVenueWithInlineKeyboard(chatId, latitude, longitude, title, address, keyboard, options) {
        options = options || {};

        options.reply_markup = {
            inline_keyboard: this.buildInlineKeyboard(chatId, keyboard)
        };

        return this.sendVenue(chatId, latitude, longitude, title, address, options);
    }

    /**
     * Send phone contacts
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {String} phoneNumber - latitude of location
     * @param {String} firstName - longitude of location
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#sendcontact
     */
    sendContact(chatId, phoneNumber, firstName, options) {
        return this._api('sendContact', this._prepareOptions(options, {
            chat_id: chatId,
            phone_number: phoneNumber,
            first_name: firstName
        }));
    }

    /**
     * Edit text messages sent by the bot or via the bot (for inline bots)
     * @param {String} text - new text of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagetext
     */
    editMessageText(text, options) {
        return this._api('editMessageText', this._prepareOptions(options, {
            text: text
        }));
    }

    /**
     * Edit chat text messages sent by the bot
     * @param {Number|String} chatId - unique identifier for the target chat
     * @param {Number} messageId - unique identifier of the sent message
     * @param {String} text - new text of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagetext
     */
    editChatMessageText(chatId, messageId, text, options) {
        return this._api('editMessageText', this._prepareOptions(options, {
            chat_id: chatId,
            message_id: messageId,
            text: text
        }));
    }

    /**
     * Edit inline text messages sent via the bot
     * @param {Number} messageId - identifier of the inline message
     * @param {String} text - new text of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagetext
     */
    editInlineMessageText(messageId, text, options) {
        return this._api('editMessageText', this._prepareOptions(options, {
            inline_message_id: messageId,
            text: text
        }));
    }

    /**
     * Edit captions of messages sent by the bot or via the bot (for inline bots)
     * @param {String} caption - new caption of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagecaption
     */
    editMessageCaption(caption, options) {
        return this._api('editMessageCaption', this._prepareOptions(options, {
            caption: caption
        }));
    }

    /**
     * Edit captions of chat messages sent by the bot
     * @param {Number|String} chatId - unique identifier for the target chat
     * @param {Number} messageId - unique identifier of the sent message
     * @param {String} caption - new caption of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagecaption
     */
    editChatMessageCaption(chatId, messageId, caption, options) {
        return this._api('editMessageCaption', this._prepareOptions(options, {
            chat_id: chatId,
            message_id: messageId,
            caption: caption
        }));
    }

    /**
     * Edit captions of inline messages sent via the bot
     * @param {Number} messageId - identifier of the inline message
     * @param {String} caption - new caption of the message
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagecaption
     */
    editInlineMessageCaption(messageId, caption, options) {
        return this._api('editMessageCaption', this._prepareOptions(options, {
            inline_message_id: messageId,
            caption: caption
        }));
    }

    /**
     * Edit only the reply markup of messages sent by the bot or via the bot (for inline bots)
     * @param {Object} replyMarkup - object of inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagereplymarkup
     */
    editMessageReplyMarkup(replyMarkup, options) {
        return this._api('editMessageReplyMarkup', this._prepareOptions(options, {
            reply_markup: JSON.stringify(replyMarkup)
        }));
    }

    /**
     * Edit only the reply markup of chat messages sent by the bot
     * @param {Number|String} chatId - unique identifier for the target chat
     * @param {Number} messageId - unique identifier of the sent message
     * @param {Object} replyMarkup - object of inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagereplymarkup
     */
    editChatMessageReplyMarkup(chatId, messageId, replyMarkup, options) {
        return this._api('editMessageReplyMarkup', this._prepareOptions(options, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: JSON.stringify(replyMarkup)
        }));
    }

    /**
     * Edit only the reply markup of inline messages sent via the bot
     * @param {Number} messageId - unique identifier of the inline message
     * @param {Object} replyMarkup - object of inline keyboard
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#editmessagereplymarkup
     */
    editInlineMessageReplyMarkup(messageId, replyMarkup, options) {
        return this._api('editMessageReplyMarkup', this._prepareOptions(options, {
            inline_message_id: messageId,
            reply_markup: JSON.stringify(replyMarkup)
        }));
    }

    /**
     * Get basic info about a file and prepare it for downloading
     * @param {String} fileId - file identifier to get info about
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#getfile
     */
    getFile(fileId) {
        return this._api('getFile', {
            file_id: fileId
        });
    }

    /**
     * Get a list of profile pictures for a user
     * @param {Number} userId - unique identifier of the target user
     * @param {Number} [offset] - sequential number of the first photo to be returned
     * @param {Number} [limit] - limits the number of photos to be retrieved.
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#getuserprofilephotos
     */
    getUserProfilePhotos(userId, offset, limit) {
        return this._api('getUserProfilePhotos', {
            user_id: userId,
            offset: offset,
            limit: limit
        });
    }

    /**
     * Send answers to callback queries sent from inline keyboards
     * @param {String} cbQueryId - unique identifier for the query to be answered
     * @param {String} text - text of the notification. If not specified, nothing will be shown to the user
     * @param {Object} [options] - additional telegram query options
     * @return {Promise}
     * @see https://core.telegram.org/bots/api#answercallbackquery
     */
    answerCallbackQuery(cbQueryId, text, options) {
        return this._api('answerCallbackQuery', this._prepareOptions(options, {
            callback_query_id: cbQueryId,
            text: text
        }));
    }

    /* Additional methods */

    /**
     * Add handler for command
     * @param {String} command - command string (/add or add or add new user)
     * @param {Function} cb - callback for command
     */
    command(command, cb) {
        if (this._isCommand(command)) {
            command = command.replace('/', '');
        }

        let parsedCommand = command.replace(/\s/g, '').split(':');
        let commandName = parsedCommand[0];
        let params = parsedCommand.slice(1);

        this._commands[commandName] = {
            callback: cb,
            params: params.length ? params : null
        };
    }

    /**
     * Add handler for text command
     * @param {String} text - text or callback, if function has only one parameter
     * @param {Function} [cb] - callback
     */
    text(text, cb) {
        if (isFunction(text)) {
            this._onAllText = text;
            return;
        }

        if (this._isCommand(text)) {
            text = command.replace('/', '');
        }

        this._textCommands[text] = cb;
    }

    /**
     * Add some action before update process
     * @param {Function} cb - callback for execute command after some action
     */
    beforeUpdate(cb) {
        this._beforeUpdate = cb;
    }

    /**
     * Add some action before command execution
     * @param {Function} cb - callback for execute command after some action
     */
    beforeCommand(cb) {
        // before command callback get two params: scope and next function
        this._beforeCommand = cb;
    }

    /**
     * Add some action before text command execution
     * @param {Function} cb - callback
     */
    beforeText(cb) {
        // before text callback get two params: scope and next function
        this._beforeText = cb;
    }

    /**
     * Wait for user answer message and execute callback when the message will be received
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Function} cb - callback
     */
    waitForMessage(chatId, cb) {
        this._waitingCallbacks[chatId] = cb;
    }

    /**
     * Add some action if no callbacks found for callback query
     * @param {Function} cb - callback
     */
    onEmptyCallbackQuery(cb) {
        // before command callback get two params: scope and next function
        this._onEmptyCallbackQuery = cb;
    }

    /**
     * Build keyboard
     * @param {Object[]} items -keyboard items
     * @return {Object[]}
     */
    buildKeyboard(items) {
        let keyboard = [];

        function getButton(btn) {
            let button = { text: btn.text };

            if (btn.request_location) {
                button.request_location = true;
            }

            if (btn.request_contact) {
                button.request_contact = true;
            }

            return button;
        }

        items.forEach((item) => {
            if (isArray(item)) {
                let row = map(item, (cellItem) => {
                    return getButton(cellItem);
                });

                keyboard.push(row);
            } else if (isString(item)) {
                keyboard.push([item]);
            } else {
                keyboard.push([getButton(item)]);
            }
        });

        return keyboard;
    }

    /**
     * Build inline keyboard
     * @param {Object[]} items - keyboard items
     * @return {Object[]}
     */
    buildInlineKeyboard(chatId, items) {
        let keyboard = [];

        let getButton = (btn) => {
            let rnd = Math.random().toString();
            let resBtn = { text: btn.text };

            if (btn.url) {
                resBtn.url = btn.url;
                return resBtn;
            }

            resBtn.callback_data = rnd;
            this._callbackQueriesCallbacks[chatId + ':' + rnd] = btn.callback;

            return resBtn;
        }

        items.forEach((item) => {
            if (isArray(item)) {
                let row = map(item, (cellItem) => {
                    return getButton(cellItem);
                });

                keyboard.push(row);
            } else if (isString(item)) {
                keyboard.push([item]);
            } else {
                keyboard.push([getButton(item)]);
            }
        });

        return keyboard;
    }

    /**
     * Send menu with reply keyboards
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Object} menuData - data for menu: options, keyboard, etc.
     * @param {Function} [cb] - callback which will be executed after button callback
     */
    sendMenu(chatId, menuData, cb) {
        let keyboard = this.buildKeyboard(menuData.keyboard);
        let flattenKeyboard = flattenDeep(menuData.keyboard);

        let options = {
            reply_markup: {
                hide_keyboard: true,
                resize_keyboard: true,
                one_time_keyboard: true,
                keyboard: keyboard
            }
        };

        forEach(menuData.options, (option, key) => {
            if (key === 'reply_markup') {
                option = assign(options[key], option);
            }

            options[key] = option;
        });

        let waitForMessage = () => {
            this.waitForMessage(chatId, ($) => {
                let text = $.message.text;
                let location = $.message.location;
                let contact = $.message.contact;
                let existedButton;

                if (text) {
                    existedButton = find(flattenKeyboard, { text: text });
                    existedButton.callback && existedButton.callback();
                    existedButton || waitForMessage();
                } else if (location) {
                    existedButton = find(flattenKeyboard, { request_location: true });
                    existedButton.callback && existedButton.callback(location);
                } else if (contact) {
                    existedButton = find(flattenKeyboard, { request_contact: true });
                    existedButton.callback && existedButton.callback(contact);
                }

                cb && existedButton && cb($);
            });
        }

        this.sendMessage(chatId, menuData.message, options);

        waitForMessage();
    }

    /**
     * Send form to user
     * @param {Number|String} chatId - unique identifier for the message recipient
     * @param {Object} formData - data for form
     * @param {Function} cb - callback with result
     */
    sendForm(chatId, formData, cb) {
        let i = 0;
        let result = {};
        let fields = Object.keys(formData.fields);
        let actions = formData.actions || {};

        forEach(formData.options, (option, key) => {
            if (key === 'reply_markup') {
                option = assign(options[key], option);
            }

            options[key] = option;
        });

        let process = () => {
            let key = fields[i]
            let field = formData.fields[key];
            let keyboard, flattenKeyboard, actionButtons;

            if (isFunction(field)) {
                field = field(result);

                if (!field) {
                    i++;

                    if (i === fields.length) {
                        cb(result);
                        return;
                    }

                    process();
                }
            }

            if (field.keyboard) {
                keyboard = this.buildKeyboard(field.keyboard);
                flattenKeyboard = flattenDeep(field.keyboard);
                actionButtons = map(flattenKeyboard, (item) => {
                    return item.action && item;
                });
            }

            let onError = () => {
                field.error ? this.sendMessage(chatId, field.error, { disable_web_page_preview: true }).then(() => {
                    process();
                }) : process();
            };

            let keyboardValidator = (text) => {
                return find(flattenKeyboard, { text: text }) || includes(flattenKeyboard, text);
            };

            let options = {
                disable_web_page_preview: true,
                reply_markup: keyboard ? {
                    one_time_keyboard: true,
                    resize_keyboard: true,
                    keyboard: keyboard
                } : ''
            };

            if (field.options) {
                assign(options, field.options);
            }

            this.sendMessage(chatId, field.q, options);

            this.waitForMessage(chatId, ($) => {
                let isValid = field.validator ? Boolean(field.validator($.message, keyboardValidator)) : true;

                if (isValid) {
                    if ($.message.text) {
                        let actionButton = find(actionButtons, { text: $.message.text });

                        if (actionButton && actions[actionButton.action]) {
                            actions[actionButton.action](result, cb);
                            return;
                        }
                    }

                    result[key] = $.message.text || $.message.location || $.message.contact;
                    i++;

                    if (i === fields.length) {
                        cb(result);
                        return;
                    }

                    process();
                } else {
                    onError();
                }
            });
        }

        process();
    }

    goTo(scope, command) {
        this._waitingCallbacks[scope.chatId] = null;
        scope.message.text = command;

        this._processMessage(scope);
    }
}

module.exports = (token, options) => {
    return new tgBot(token, options)
};
