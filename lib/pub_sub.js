function PubSub(messenger, pubber) {
    this.filters = {};
    this.ms = messenger;
    this.pubber = pubber;
}

PubSub.prototype.sub = function(key) {
    var ms = this.ms;

    if(key) {
        if(this.filters[key])
            return;

        var filter = function(msg, msg_key) {
            console.log('keys', msg_key, key)
            if(msg_key == key)
                ms.send(msg);
        }
    }
    else {
        // no key, so don't filter
        var filter = function(msg) {
            ms.send(msg);
        }
    }

    // store the filter for this user
    // this is so we can unsub later
    this.filters[key] = filter;

    this.pubber.on('pub', filter);
}

PubSub.prototype.unsub = function(key) {

    var filter = this.filters[key];
    if(filter)
        this.pubber.removeListener('pub', filter);
}

PubSub.prototype.close = function() {
    for(var key in this.filters) {
        var filter = this.filters[key];
        this.pubber.removeListener('pub', filter);
    }
}

PubSub.prototype.pub = function(msg, key) {
    this.pubber.emit('pub', msg, key);
}

exports.PubSub = PubSub;
