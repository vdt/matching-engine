function PubSub(socket, pubber) {
    this.filters = {};
    this.socket = socket;
    this.pubber = pubber;
}

PubSub.prototype.sub = function(key) {
    var socket = this.socket;

    if(key) {
        if(this.filters[key])
            return;

        var filter = function(msg, msg_key) {
            console.log('keys', msg_key, key)
            if(msg_key == key)
                socket.write(msg);
        }
    }
    else {
        // no key, so don't filter
        var filter = function(msg) {
            socket.write(msg);
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
    var filter = null;
    while(filter = this.filters.shift())
        this.pubber.removeListener('pub', filter);    
}

PubSub.prototype.pub = function(msg, key) {
    this.pubber.emit('pub', msg, key);
}

exports.PubSub = PubSub;