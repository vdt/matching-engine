var net = require('net');
var msgpack = require('msgpack');
var fs = require('fs');
var assert = require('assert');

var Matcher = require('../matcher');
var json2 = require('../deps/json2'); // for pretty-serialize

var PORT = 6666;
var BASE_DIR = __dirname + "/unit";
var TIMEOUT = 100;

var gen_golds = process.argv.length > 2 && process.argv[2] == '-g';

var matcher = new Matcher();

function subscribe(socket, cb) {
    var smsg = msgpack.pack({
        type: 'sub'
    });

    socket.write(smsg);
}

function do_test(test_name, cb) {
    matcher.start(PORT, function() {
        run_test(test_name, cb);
    });
}

function run_test(test_name, cb) {
    var test_dir = BASE_DIR + "/" + test_name;
    var recv_filename = test_dir + "/recv.json";
    var state_filename = test_dir + "/state.json";
    var orders = JSON.parse(fs.readFileSync(test_dir + "/send.json"));
    var start_time;
    var end_time;

    var tid; // timeout id

    var client = net.createConnection(PORT);
    client.on('connect', function() {
        subscribe(client);

        var ms = new msgpack.Stream(client);
        ms.addListener('msg', function(msg) {
            end_time = Date.now()/1000;
            resps.push(msg);

            clearTimeout(tid);
            tid = setTimeout(end, TIMEOUT);
        });

        start_time = Date.now()/1000;
        orders.forEach(function(order){
            client.write(msgpack.pack(order));
        });
        console.log('sent all messages for', test_name)

        tid = setTimeout(end, TIMEOUT);
    });

    var resps = [];
    var states = [];

    matcher.events.on('process', function() {
        states.push(matcher.state());
    });

    function end() {
        matcher.stop();
        
        // remove all timestamps
        resps.forEach(function(r) {
            delete r.timestamp;
            delete r.payload.exchange_time;
        });

        if(gen_golds) {
            fs.writeFileSync(recv_filename, json2.stringify(resps, null, '\t'));
            fs.writeFileSync(state_filename, json2.stringify(states, null, '\t'));
        }
        else {
            var grecv = JSON.parse(fs.readFileSync(recv_filename));
            var gstate = JSON.parse(fs.readFileSync(state_filename));
            assert.deepEqual(resps, grecv);
            assert.deepEqual(states, gstate);
        }

        if(cb)
            cb({
                time: end_time - start_time
            });
    }
}

var tests = fs.readdirSync(BASE_DIR);

function process_tests(tests) {
    var test = tests.shift();
    if(test) {
        console.log('running test', test);
        do_test(test, function(ret) {
            console.log('ran test in', ret.time);
            process_tests(tests);
        });
    }
    else
        process.exit(); // TODO: why is this necessary
}

process_tests(tests);
