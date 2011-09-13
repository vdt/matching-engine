var net = require('net');

var Messenger = require('bitfloor/messenger');

var config = require('bitfloor/config').get_matcher(process.argv[2]);

var client = net.createConnection(config.client.port);
client.on('connect', function() {
    var ms = new Messenger(client);

    ms.addListener('msg', function(msg) {
        console.log(msg);
        process.exit();
    });

    ms.send({type: 'state'});
});
