'use strict';

var SMTPConnection = require('smtp-connection');
var packageData = require('../package.json');
var wellknown = require('nodemailer-wellknown');
var clone = require('clone');

var EventEmitter = require('events').EventEmitter;
var util = require('util');

// expose to the world
module.exports = function(options) {
    return new SMTPPool(options);
};

/**
 * Creates a SMTP pool transport object for Nodemailer
 *
 * @constructor
 * @param {Object} options SMTP Connection options
 */
function SMTPPool(options) {
    EventEmitter.call(this);

    var hostData;

    this.options = options && clone(options) || {};
    this.options.maxConnections = this.options.maxConnections || 5;
    this.options.maxMessages = this.options.maxMessages || 100;

    if (this.options.service && (hostData = wellknown(this.options.service))) {
        Object.keys(hostData).forEach(function(key) {
            if (!(key in this.options)) {
                this.options[key] = hostData[key];
            }
        }.bind(this));
    }

    // temporary object
    var connection = new SMTPConnection(this.options);

    this.name = 'SMTP (pool)';
    this.version = packageData.version + '[client:' + connection.version + ']';

    this._rateLimit = {
        counter: 0,
        timeout: null,
        waiting: [],
        checkpoint: false
    };
    this._closed = false;
    this._queue = [];
    this._connections = [];
    this._connectionCounter = 0;
}
util.inherits(SMTPPool, EventEmitter);

/**
 * Queues an e-mail to be sent using the selected settings
 *
 * @param {Object} mail Mail object
 * @param {Function} callback Callback function
 */
SMTPPool.prototype.send = function(mail, callback) {
    var called = false;
    this._queue.push({
        mail: mail,
        callback: function(){
            // callback might me fired twice, depending on how connection error is handled
            // so we enforce strict limit of single run only
            if(called){
                return;
            }
            called = true;
            callback.apply(null, Array.prototype.slice.call(arguments));
        }
    });
    this._processMessages();
};

/**
 * Closes all connections in the pool. If there is a message being sent, the connection
 * is closed later
 */
SMTPPool.prototype.close = function() {
    var connection;
    this._closed = true;

    // clear rate limit timer if it exists
    clearTimeout(this._rateLimit.timeout);

    // remove all available connections
    for (var i = this._connections.length - 1; i >= 0; i--) {
        if (this._connections[i].available) {
            connection = this._connections[i];
            connection.close();

            this.emit('log', {
                type: 'close',
                message: 'Connection #' + connection.id + ' removed'
            });

            this._connections.splice(i, 1);
        }
    }

    if (!this._connections.length) {
        this.emit('log', {
            type: 'close',
            message: 'All connections removed'
        });
    }
};

/**
 * Check the queue and available connections. If there is a message to be sent and there is
 * an available connection, then use this connection to send the mail
 */
SMTPPool.prototype._processMessages = function() {
    var connection, element;

    if (!this._queue.length || this._closed) {
        return;
    }

    // find first available connection
    for (var i = 0, len = this._connections.length; i < len; i++) {
        if (this._connections[i].available) {
            connection = this._connections[i];
            break;
        }
    }

    if (!connection && this._connections.length < this.options.maxConnections) {
        connection = this._createConnection();
    }

    if (!connection) {
        return;
    }

    element = this._queue.shift();
    connection.available = false;

    if (this.options.debug) {
        this.emit('log', {
            type: 'message',
            message: 'Assigned message to connection #' + connection.id
        });
    }

    if (this.options.rateLimit) {
        this._rateLimit.counter++;
        if (!this._rateLimit.checkpoint) {
            this._rateLimit.checkpoint = Date.now();
        }
    }

    connection.once('error', element.callback);
    connection.send(element.mail, function (err, info) {
        connection.removeListener('error', element.callback);
        element.callback(err, info);
    });
};

/**
 * Creates a new pool resource
 */
SMTPPool.prototype._createConnection = function() {
    var connection = new PoolResource(this);
    connection.id = ++this._connectionCounter;

    if (this.options.debug) {
        this.emit('log', {
            type: 'created',
            message: 'New connection #' + connection.id
        });
    }

    connection.on('log', function(log) {
        this.emit('log', log);
    }.bind(this));

    // resource comes available
    connection.on('available', function() {
        if (this.options.debug) {
            this.emit('log', {
                type: 'available',
                message: 'Connection #' + connection.id + ' became available'
            });
        }

        if (this._closed) {
            // if already closed run close() that will remove this connections from connections list
            this.close();
        } else {
            // check if there's anything else to send
            this._processMessages();
        }
    }.bind(this));

    // resource is terminated with an error
    connection.once('error', function(err) {
        if (this.options.debug) {
            this.emit('log', {
                type: 'error',
                message: 'Connection #' + connection.id + ' returned an error: ' + err.message
            });
        }

        // remove the erroneus connection from connections list
        for (var i = 0, len = this._connections.length; i < len; i++) {
            if (this._connections[i] === connection) {
                this._connections.splice(i, 1);
                break;
            }
        }

        if (this._closed) {
            this.close();
        } else {
            setTimeout(this._processMessages.bind(this), 100);
        }
    }.bind(this));

    this._connections.push(connection);

    return connection;
};

/**
 * Checks if connections have hit current rate limit and if so, queues the availability callback
 *
 * @param {Function} callback Callback function to run once rate limiter has been cleared
 */
SMTPPool.prototype._checkRateLimit = function(callback) {
    if (!this.options.rateLimit) {
        return callback();
    }

    var now = Date.now();

    if (this._rateLimit.counter < this.options.rateLimit) {
        return callback();
    }

    this._rateLimit.waiting.push(callback);

    if (this._rateLimit.checkpoint <= now - 1000) {
        return this._clearRateLimit();
    } else if (!this._rateLimit.timeout) {
        this._rateLimit.timeout = setTimeout(this._clearRateLimit.bind(this), 1000 - (now - this._rateLimit.checkpoint));
        this._rateLimit.checkpoint = now;
    }
};

/**
 * Clears current rate limit limitation and runs paused callback
 */
SMTPPool.prototype._clearRateLimit = function() {
    clearTimeout(this._rateLimit.timeout);
    this._rateLimit.timeout = null;
    this._rateLimit.counter = 0;
    this._rateLimit.checkpoint = false;

    // resume all paused connections
    while (this._rateLimit.waiting.length) {
        var cb = this._rateLimit.waiting.shift();
        setImmediate(cb);
    }
};

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
PoolResource.prototype.connect = function(callback) {
    var returned = false;

    if (!this.connection) {
        this.connection = new SMTPConnection(this.options);
    }

    this.connection.on('log', function(log) {
        this.emit('log', log);
    }.bind(this));

    this.connection.once('error', function(err) {
        this.emit('error', err);
        if (returned) {
            return;
        }
        returned = true;
        return callback(err);
    }.bind(this));

    this.connection.once('close', function() {
        this.emit('error', new Error('Connection was closed'));
        if (returned) {
            return;
        }
        returned = true;
        return callback();
    }.bind(this));

    this.connection.connect(function() {
        if (returned) {
            return;
        }

        if (this.options.auth) {
            this.connection.login(this.options.auth, function(err) {
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
            callback(null, true);
        }
    }.bind(this));
};

/**
 * Sends an e-mail to be sent using the selected settings
 *
 * @param {Object} mail Mail object
 * @param {Function} callback Callback function
 */
PoolResource.prototype.send = function(mail, callback) {
    if (!this._connected) {
        this.connect(function(err) {
            if (err) {
                return callback(err);
            }
            this.send(mail, callback);
        }.bind(this));
        return;
    }

    this.connection.send(mail.data.envelope || mail.message.getEnvelope(), mail.message.createReadStream(), function(err, info) {
        var envelope;
        this.messages++;

        if (err) {
            this.connection.close();
            this.emit('error', err);
            return callback(err);
        } else {
            envelope = mail.data.envelope || mail.message.getEnvelope();
            info.envelope = {
                from: envelope.from,
                to: envelope.to
            };
            info.messageId = (mail.message.getHeader('message-id') || '').replace(/[<>\s]/g, '');
            callback(null, info);
        }

        if (this.messages >= this.options.maxMessages) {
            this.connection.close();
            this.emit('error', new Error('Resource exhausted'));
        } else {
            this.pool._checkRateLimit(function() {
                this.available = true;
                this.emit('available');
            }.bind(this));
        }
    }.bind(this));
};

/**
 * Closes the connection
 */
PoolResource.prototype.close = function() {
    if (this.connection) {
        this.connection.close();
    }
};
