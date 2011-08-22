# a simple script to update the precision for the tests

import json, sys, os

def update(file):
    with open(file) as f:
        o = json.load(f);

    for x in o:
        p = x.get('payload')
        if not p: continue

        size = p.get('size')
        if not size: continue

        p['size'] = int(round(p['size'] * 1e8))
        p['price'] = int(round(p['price'] * 1e8))


    with open(file, 'w') as f:
        json.dump(o, f, indent=4)

dirs = os.listdir('unit')
for d in dirs:
    update(os.path.join('unit', d, "send.json"))
