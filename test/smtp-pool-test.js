'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

var chai = require('chai');
var expect = chai.expect;
var smtpPool = require('../src/smtp-pool');
var SMTPServer = require('smtp-server').SMTPServer;
chai.config.includeStack = true;

var PORT_NUMBER = 8397;

function MockBuilder(envelope, message) {
    this.envelope = envelope;
    this.message = message;
}

MockBuilder.prototype.getEnvelope = function () {
    return this.envelope;
};

MockBuilder.prototype.createReadStream = function () {
    return this.message;
};

MockBuilder.prototype.getHeader = function () {
    return 'teretere';
};

describe('SMTP Pool Tests', function () {
    this.timeout(100 * 1000);

    var server;

    beforeEach(function (done) {
        server = new SMTPServer({
            authMethods: ['PLAIN', 'XOAUTH2'],
            disabledCommands: ['STARTTLS'],

            onData: function (stream, session, callback) {
                stream.on('data', function () {});
                stream.on('end', callback);
            },

            onAuth: function (auth, session, callback) {
                if (auth.method !== 'XOAUTH2') {
                    if (auth.username !== 'testuser' || auth.password !== 'testpass') {
                        return callback(new Error('Invalid username or password'));
                    }
                } else {
                    if (auth.username !== 'testuser' || auth.accessToken !== 'testtoken') {
                        return callback(null, {
                            data: {
                                status: '401',
                                schemes: 'bearer mac',
                                scope: 'my_smtp_access_scope_name'
                            }
                        });
                    }
                }
                callback(null, {
                    user: 123
                });
            },
            onMailFrom: function (address, session, callback) {
                if (!/@valid.sender/.test(address.address)) {
                    return callback(new Error('Only user@valid.sender is allowed to send mail'));
                }
                return callback(); // Accept the address
            },
            onRcptTo: function (address, session, callback) {
                if (!/@valid.recipient/.test(address.address)) {
                    return callback(new Error('Only user@valid.recipient is allowed to receive mail'));
                }

                if (!/timeout/.test(address.address)) {
                    return callback(); // Accept the address
                }
            },
            logger: false
        });

        server.listen(PORT_NUMBER, done);
    });

    afterEach(function (done) {
        server.close(done);
    });

    it('Should expose version number', function () {
        var pool = smtpPool();
        expect(pool.name).to.exist;
        expect(pool.version).to.exist;
    });

    it('Should detect wellknown data', function () {
        var pool = smtpPool({
            service: 'google mail'
        });
        expect(pool.options.host).to.equal('smtp.gmail.com');
        expect(pool.options.port).to.equal(465);
        expect(pool.options.secure).to.be.true;
    });

    it('should send mail', function (done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });

        var message = new Array(1024).join('teretere, vana kere\n');

        server.onData = function (stream, session, callback) {
            var chunks = [];
            stream.on('data', function (chunk) {
                chunks.push(chunk);
            });
            stream.on('end', function () {
                var body = Buffer.concat(chunks);
                expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
                callback();
            });
        };

        pool.send({
            data: {},
            message: new MockBuilder({
                from: 'test@valid.sender',
                to: 'test@valid.recipient'
            }, message)
        }, function (err) {
            expect(err).to.not.exist;
            pool.close();
            done();
        });
    });

    it('should send multiple mails', function (done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        server.onData = function (stream, session, callback) {
            var chunks = [];
            stream.on('data', function (chunk) {
                chunks.push(chunk);
            });
            stream.on('end', function () {
                var body = Buffer.concat(chunks);
                expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
                callback();
            });
        };

        function sendMessage(callback) {
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function (err) {
                expect(err).to.not.exist;
                callback();
            });
        }

        var total = 100;
        var returned = 0;
        var cb = function () {
            var sent = 0;

            if (++returned === total) {
                expect(pool._connections.length).to.be.above(1);
                pool._connections.forEach(function (conn) {
                    expect(conn.messages).to.be.above(1);
                    sent += conn.messages;
                });

                expect(sent).to.be.equal(total);

                pool.close();
                done();
            }
        };
        for (var i = 0; i < total; i++) {
            sendMessage(cb);
        }
    });

    it('should tolerate connection errors', function (done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        server.onData = function (stream, session, callback) {
            var chunks = [];
            stream.on('data', function (chunk) {
                chunks.push(chunk);
            });
            stream.on('end', function () {
                var body = Buffer.concat(chunks);
                expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
                callback();
            });
        };

        var c = 0;

        function sendMessage(callback) {
            var isErr = c++ % 2; // fail 50% of messages
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: isErr ? 'test@invalid.sender' : 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function (err) {
                if (isErr) {
                    expect(err).to.exist;
                } else {
                    expect(err).to.not.exist;
                }

                callback();
            });
        }

        var total = 100;
        var returned = 0;
        var cb = function () {
            if (++returned === total) {
                pool.close();
                done();
            }
        };
        for (var i = 0; i < total; i++) {
            sendMessage(cb);
        }
    });

    it('should call back with connection errors to senders having messages in flight', function (done) {
        var pool = smtpPool({
            maxConnections: 1,
            socketTimeout: 200,
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        pool.send({
            data: {},
            message: new MockBuilder({
                from: 'test@valid.sender',
                to: 'test@valid.recipient'
            }, message)
        }, function (err) {
            expect(err).not.to.exist;
        });

        pool.send({
            data: {},
            message: new MockBuilder({
                from: 'test@valid.sender',
                to: 'test+timeout@valid.recipient'
            }, message)
        }, function (err) {
            expect(err).to.exist;
            pool.close();
            done();
        });
    });

    it('should not send more then allowed for one connection', function (done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            },
            maxConnections: 1,
            maxMessages: 5
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        server.onData = function (stream, session, callback) {
            var chunks = [];
            stream.on('data', function (chunk) {
                chunks.push(chunk);
            });
            stream.on('end', function () {
                var body = Buffer.concat(chunks);
                expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
                callback();
            });
        };

        function sendMessage(callback) {
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function (err) {
                expect(err).to.not.exist;
                callback();
            });
        }

        var total = 100;
        var returned = 0;
        var cb = function () {
            if (++returned === total) {
                expect(pool._connections.length).to.be.equal(1);
                expect(pool._connections[0].messages).to.be.below(6);
                pool.close();
                done();
            }
        };
        for (var i = 0; i < total; i++) {
            sendMessage(cb);
        }
    });

    it('should send multiple mails with rate limit', function (done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            },
            maxConnections: 10,
            rateLimit: 200 // 200 messages in sec, so sending 5000 messages should take at least 24 seconds and probably under 25 sec
        });
        var message = 'teretere, vana kere\n';
        var startTime = Date.now();

        server.onData = function (stream, session, callback) {
            var chunks = [];
            stream.on('data', function (chunk) {
                chunks.push(chunk);
            });
            stream.on('end', function () {
                var body = Buffer.concat(chunks);
                expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
                callback();
            });
        };

        function sendMessage(callback) {
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function (err) {
                expect(err).to.not.exist;
                callback();
            });
        }

        var total = 5000;
        var returned = 0;
        var cb = function () {
            if (++returned === total) {
                var endTime = Date.now();
                expect(endTime - startTime).to.be.at.least(24000);

                pool.close();
                done();
            }
        };

        var i = 0;
        var send = function () {
            if (i++ >= total) {
                return;
            }
            sendMessage(cb);
            setImmediate(send);
        };

        send();
    });
});
