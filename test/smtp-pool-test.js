'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

var chai = require('chai');
var expect = chai.expect;
var smtpPool = require('../src/smtp-pool');
var simplesmtp = require('simplesmtp');
chai.Assertion.includeStack = true;

var PORT_NUMBER = 8397;

function MockBuilder(envelope, message) {
    this.envelope = envelope;
    this.message = message;
}

MockBuilder.prototype.getEnvelope = function() {
    return this.envelope;
};

MockBuilder.prototype.createReadStream = function() {
    return this.message;
};

MockBuilder.prototype.getHeader = function() {
    return 'teretere';
};

describe('SMTP Pool Tests', function() {
    this.timeout(100 * 1000);

    var server;

    beforeEach(function(done) {
        server = new simplesmtp.createServer({
            ignoreTLS: true,
            disableDNSValidation: true,
            enableAuthentication: true,
            debug: false,
            authMethods: ['PLAIN', 'XOAUTH2']
        });

        server.setMaxListeners(0);

        server.on('authorizeUser', function(connection, username, pass, callback) {
            callback(null, username === 'testuser' && (pass === 'testpass' || pass === 'testtoken'));
        });

        server.on('validateSender', function(connection, email, callback) {
            callback(!/@valid.sender/.test(email) && new Error('Invalid sender'));
        });

        server.on('validateRecipient', function(connection, email, callback) {
            callback(!/@valid.recipient/.test(email) && new Error('Invalid recipient'));
        });

        server.listen(PORT_NUMBER, done);
    });

    afterEach(function(done) {
        server.end(done);
    });

    it('Should expose version number', function() {
        var pool = smtpPool();
        expect(pool.name).to.exist;
        expect(pool.version).to.exist;
    });

    it('Should detect wellknown data', function() {
        var pool = smtpPool({
            service: 'google mail'
        });
        expect(pool.options.host).to.equal('smtp.gmail.com');
        expect(pool.options.port).to.equal(465);
        expect(pool.options.secureConnection).to.be.true;
    });

    it('should send mail', function(done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });

        var chunks = [],
            message = new Array(1024).join('teretere, vana kere\n');

        server.on('data', function(connection, chunk) {
            chunks.push(chunk);
        });

        server.on('dataReady', function(connection, callback) {
            var body = Buffer.concat(chunks);
            expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
            callback(null, true);
        });

        pool.send({
            data: {},
            message: new MockBuilder({
                from: 'test@valid.sender',
                to: 'test@valid.recipient'
            }, message)
        }, function(err) {
            expect(err).to.not.exist;
            pool.close();
            done();
        });
    });

    it('should send multiple mails', function(done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        server.on('startData', function(connection) {
            connection.chunks = [];
        });

        server.on('data', function(connection, chunk) {
            connection.chunks.push(chunk);
        });

        server.on('dataReady', function(connection, callback) {
            var body = Buffer.concat(connection.chunks);
            expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
            callback(null, true);
        });

        function sendMessage(callback) {
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function(err) {
                expect(err).to.not.exist;
                callback();
            });
        }

        var total = 100;
        var returned = 0;
        var cb = function() {
            var sent = 0;

            if (++returned === total) {
                expect(pool._connections.length).to.be.above(1);
                pool._connections.forEach(function(conn) {
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

    it('should tolerate connection errors', function(done) {
        var pool = smtpPool({
            port: PORT_NUMBER,
            auth: {
                user: 'testuser',
                pass: 'testpass'
            }
        });
        var message = new Array(10 * 1024).join('teretere, vana kere\n');

        server.on('startData', function(connection) {
            connection.chunks = [];
        });

        server.on('data', function(connection, chunk) {
            connection.chunks.push(chunk);
        });

        server.on('dataReady', function(connection, callback) {
            var body = Buffer.concat(connection.chunks);
            expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
            callback(null, true);
        });

        var c = 0;

        function sendMessage(callback) {
            var isErr = c++ % 2; // fail 50% of messages
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: isErr ? 'test@invalid.sender' : 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function(err) {
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
        var cb = function() {
            if (++returned === total) {
                pool.close();
                done();
            }
        };
        for (var i = 0; i < total; i++) {
            sendMessage(cb);
        }
    });

    it('should not send more then allowed for one connection', function(done) {
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

        server.on('startData', function(connection) {
            connection.chunks = [];
        });

        server.on('data', function(connection, chunk) {
            connection.chunks.push(chunk);
        });

        server.on('dataReady', function(connection, callback) {
            var body = Buffer.concat(connection.chunks);
            expect(body.toString()).to.equal(message.trim().replace(/\n/g, '\r\n'));
            callback(null, true);
        });

        function sendMessage(callback) {
            pool.send({
                data: {},
                message: new MockBuilder({
                    from: 'test@valid.sender',
                    to: 'test@valid.recipient'
                }, message)
            }, function(err) {
                expect(err).to.not.exist;
                callback();
            });
        }

        var total = 100;
        var returned = 0;
        var cb = function() {
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
});