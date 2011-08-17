var net = require('net');
var fs = require('fs');
var assert = require('assert');

var Messenger = require('../../common/messenger');

//var logger = require('../../common/logger');
//logger.enable_stdout_provider();

var Matcher = require('../matcher');
var json2 = require('../deps/json2'); // for pretty-serialize

var PORT = 6666;
var BASE_DIR = __dirname + "/unit";
var TIMEOUT = 100;

var gen_golds = process.argv.length > 2 && process.argv[2] == '-g';

var matcher = new Matcher();

function subscribe(ms) {
    var smsg = {
        type: 'sub'
    };

    ms.send(smsg);
}

function do_test(test_name, cb) {
    // clear the journals
    fs.writeFileSync("./log/matcher.log", "");
    fs.writeFileSync("./log/matcher_in.log", "");

    matcher.start(PORT, function() {
        run_test(test_name, cb);
    });
}

function run_test(test_name, cb) {
    var test_dir = BASE_DIR + "/" + test_name;
    var journal_file = __dirname + "/../log/matcher.log";
    var journal_test_file = test_dir + "/journal.log";
    var recv_filename = test_dir + "/recv.json";
    var state_filename = test_dir + "/state.json";
    var orders = JSON.parse(fs.readFileSync(test_dir + "/send.json"));
    var start_time;
    var end_time;

    var tid; // timeout id

    var client = net.createConnection(PORT);
    client.on('connect', function() {
        var ms = new Messenger(client);
        subscribe(ms);

        ms.addListener('msg', function(msg) {
            end_time = Date.now()/1000;
            resps.push(msg);

            clearTimeout(tid);
            tid = setTimeout(end, TIMEOUT);
        });

        start_time = Date.now()/1000;
        orders.forEach(function(order){
            ms.send(order);
        });
        console.log('sent all messages for', test_name)

        tid = setTimeout(end, TIMEOUT);
    });

    var resps = [];
    var states = [];

    matcher.events.on('process', function() {
        states.push(matcher.state());
    });

    function process_journal(journal) {
        var a = [];
        journal.split('\n').forEach(function(line) {
            if(line.length) {
                var obj = JSON.parse(line);
                delete obj.payload.id;
                a.push(obj);
            }
        });
        remove_timestamps(a);
        return a;
    }

    // remove all timestamps from an array
    function remove_timestamps(arr) {
        arr.forEach(function(r) {
            delete r.timestamp;
            delete r.payload.exchange_time;
        });
    }

    function end() {
        client.end();
        matcher.stop();

        remove_timestamps(resps);

        var journal = fs.readFileSync(journal_file) + "";

        if(gen_golds) {
            fs.writeFileSync(journal_test_file, journal);
            fs.writeFileSync(recv_filename, json2.stringify(resps, null, '\t'));
            fs.writeFileSync(state_filename, json2.stringify(states, null, '\t'));
        }
        else {
            var grecv = JSON.parse(fs.readFileSync(recv_filename));
            var gstate = JSON.parse(fs.readFileSync(state_filename));
            var gjournal = fs.readFileSync(journal_test_file) + "";
            assert.deepEqual(resps, grecv);
            assert.deepEqual(states, gstate);
            assert.deepEqual(process_journal(journal), process_journal(gjournal));
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
}

process_tests(tests);
