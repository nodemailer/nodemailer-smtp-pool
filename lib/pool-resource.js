'use strict';

var SMTPConnection = require('smtp-connection');

var EventEmitter = require('events').EventEmitter;
var util = require('util');

module.exports = PoolResource;

/**
 * Creates an element for the pool
 *
 * @constructor
 * @param {Object} options SMTPPool instance
 */
function PoolResource(pool) {
    EventEmitter.call(this);
    this.pool = pool;
    this.options = pool.options;

    this._connection = false;
    this._connected = false;

    this.messages = 0;
    this.available = true;
}
util.inherits(PoolResource, EventEmitter);

/**
 * Initiates a connection to the SMTP server
 *
 * @param {Function} callback Callback function to run once the connection is established or failed
 */
PoolResource.prototype.connect = function (callback) {
    var returned = false;

    if (!this.connection) {
        this.connection = new SMTPConnection(this.options);
    }

    this.connection.on('log', function (log) {
        this.emit('log', log);
    }.bind(this));

    this.connection.once('error', function (err) {
        this.emit('error', err);
        if (returned) {
            return;
        }
        returned = true;
        return callback(err);
    }.bind(this));

    this.connection.once('end', function () {
        this.close();
        if (returned) {
            return;
        }
        returned = true;
        return callback();
    }.bind(this));

    this.connection.connect(function () {
        if (returned) {
            return;
        }

        if (this.options.auth) {
            this.connection.login(this.options.auth, function (err) {
                if (returned) {
                    return;
                }
                returned = true;

                if (err) {
                    this.connection.close();
                    this.emit('error', err);
                    return callback(err);
                }

                this._connected = true;
                callback(null, true);
            }.bind(this));
        } else {
            returned = true;
            this._connected = true;
            return callback(null, true);
        }
    }.bind(this));
};

/**
 * Sends an e-mail to be sent using the selected settings
 *
 * @param {Object} mail Mail object
 * @param {Function} callback Callback function
 */
PoolResource.prototype.send = function (mail, callback) {
    if (!this._connected) {
        this.connect(function (err) {
            if (err) {
                return callback(err);
            }
            this.send(mail, callback);
        }.bind(this));
        return;
    }

    this.connection.send(mail.data.envelope || mail.message.getEnvelope(), mail.message.createReadStream(), function (err, info) {
        var envelope;
        this.messages++;

        if (err) {
            this.connection.close();
            this.emit('error', err);
            return callback(err);
        }

        envelope = mail.data.envelope || mail.message.getEnvelope();
        info.envelope = {
            from: envelope.from,
            to: envelope.to
        };
        info.messageId = (mail.message.getHeader('message-id') || '').replace(/[<>\s]/g, '');

        setImmediate(function () {
            if (this.messages >= this.options.maxMessages) {
                this.connection.close();
                this.emit('error', new Error('Resource exhausted'));
            } else {
                this.pool._checkRateLimit(function () {
                    this.available = true;
                    this.emit('available');
                }.bind(this));
            }
        }.bind(this));

        callback(null, info);
    }.bind(this));
};

/**
 * Closes the connection
 */
PoolResource.prototype.close = function () {
    this._connected = false;
    if (this.connection) {
        this.connection.close();
    }
    this.emit('close');
};
