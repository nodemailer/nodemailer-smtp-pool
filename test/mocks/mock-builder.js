'use strict';

var Readable = require('stream').Readable;
var util = require('util');
util.inherits(OneMessageStream, Readable);

function OneMessageStream(message) {
    var readOnce = false;
    Readable.call(this);
    this._read = function(){
        this.push(readOnce ? null : message);
        readOnce = true;
    };
}

function MockBuilder(envelope, message) {
    this.envelope = envelope;
    this.message = message;
}

MockBuilder.prototype.getEnvelope = function() {
    return this.envelope;
};

MockBuilder.prototype.createReadStream = function() {
    return new OneMessageStream(this.message);
};

MockBuilder.prototype.getHeader = function() {
    return 'teretere';
};

module.exports = MockBuilder;
