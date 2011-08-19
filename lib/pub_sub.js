var events = require('events');

function PubSub(messenger) {
    this.filters = {};
    this.ms = messenger;
};

PubSub.prototype = new events.EventEmitter();

PubSub.prototype.sub = function(key) {
    var ms = this.ms;

    if(key) {
        if(this.filters[key])
            return;

        var filter = function(msg, msg_key) {
            if(msg_key == key)
                ms.send(msg);
        }
    } else {
        // no key, so don't filter
        var filter = function(msg) {
            ms.send(msg);
        }
    }

    // store the filter for this user
    // this is so we can unsub later
    this.filters[key] = filter;

    // run every published message through the outgoing filter
    this.on('pub', filter);
}

PubSub.prototype.unsub = function(key) {

    var filter = this.filters[key];
    if(filter)
        this.removeListener('pub', filter);
}

PubSub.prototype.close = function() {
    for(var key in this.filters) {
        var filter = this.filters[key];
        this.removeListener('pub', filter);
    }
}

PubSub.prototype.pub = function(key, msg) {
    this.emit('pub', msg, key);
}

exports.PubSub = PubSub;
