// MIDI control tests for the FV-1 simulator.
//
// Web MIDI cannot be driven from a headless browser, so these tests inject raw
// messages through the window.midiHandleMessage hook that fv1-midi.js exposes
// and check what the simulator did with them. That covers parsing, the channel
// filter, CC102 polarity and the deferred display path without a controller
// being plugged in. Hot-plug and the permission prompt still need a real one.
//
//     node midi-test.js

const puppeteer = require('puppeteer');
const path = require('path');

const CH1 = 0xB0;   // control change, channel 1
const CH3 = 0xB2;
const CH7 = 0xB6;

let failures = 0;

function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        console.log('  pass  ' + name);
    } else {
        console.log('  FAIL  ' + name + '\n          expected ' + e + '\n          got      ' + a);
        failures++;
    }
}

async function run() {
    const browser = await puppeteer.launch({headless: 'new'});
    const page = await browser.newPage();

    // Stand in for a pair of controllers. Web MIDI reports no devices in a
    // headless browser, so the device menu, the attach logic and the hot-plug
    // path would otherwise never be exercised.
    await page.evaluateOnNewDocument(() => {
        const inputs = new Map();
        const make = (id, name) => ({id: id, name: name, onmidimessage: null});
        inputs.set('a', make('a', 'Fake Controller'));
        inputs.set('b', make('b', 'Second Device'));
        const access = {inputs: inputs, onstatechange: null};
        window.__fakeMidi = access;
        window.__fakeMidiMake = make;
        navigator.requestMIDIAccess = () => Promise.resolve(access);
    });

    const url = 'file://' + path.resolve(__dirname, '../Assembler/index.html');
    await page.goto(url, {waitUntil: 'networkidle0', timeout: 30000});
    await page.waitForFunction(() => typeof window.midiHandleMessage === 'function',
        {timeout: 15000});

    // Helpers that run inside the page.
    const send = (...bytes) => page.evaluate(
        (b) => window.midiHandleMessage(new Uint8Array(b)), bytes);
    const pots = () => page.evaluate(() => window.simGetPots());
    const bypassed = () => page.evaluate(
        () => document.getElementById('simBypass').checked);
    const setChannel = (ch) => page.evaluate((c) => {
        document.getElementById('midiChannel').value = String(c);
        midiOnChannelChange();
    }, ch);
    const frame = () => page.evaluate(
        () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    console.log('\nPot control');
    await send(CH1, 50, 127);
    await send(CH1, 51, 0);
    await send(CH1, 52, 64);
    // 64/127 is not a whole percent: the core must get the CC value itself, not
    // the value the slider is able to display.
    check('CC50/51/52 set the pots at full 7-bit resolution',
        (await pots()).slice(0, 3), [1, 0, 64 / 127]);


    await frame();
    check('sliders and readouts catch up on the next frame',
        await page.evaluate(() => [0, 1, 2].map(i => [
            document.getElementById('simPot' + i).value,
            document.getElementById('simPot' + i + 'Value').textContent
        ])),
        [['100', '100%'], ['0', '0%'], ['50', '50%']]);

    check('the last message is logged',
        await page.evaluate(() => document.getElementById('midiLine').textContent),
        'CC52 → POT2 · 50%');

    // POT3-POT5 exist only under '#extended'. Their sliders stay hidden for a
    // stock build, but the CCs still track them, so a controller left where it
    // was does not jump when an extended program is loaded.
    await send(CH1, 53, 127);
    await send(CH1, 54, 0);
    await send(CH1, 55, 32);
    check('CC53/54/55 reach POT3-POT5',
        (await pots()).slice(3), [1, 0, 32 / 127]);
    check('there are six pots in all', (await pots()).length, 6);

    await frame();
    check('the extended pots reach their sliders too',
        await page.evaluate(() => [3, 4, 5].map(i => [
            document.getElementById('simPot' + i).value,
            document.getElementById('simPot' + i + 'Value').textContent
        ])),
        [['100', '100%'], ['0', '0%'], ['25', '25%']]);

    check('the last message names the pot it moved',
        await page.evaluate(() => document.getElementById('midiLine').textContent),
        'CC55 \u2192 POT5 \u00b7 25%');

    // put them back so the checks below start from a known place
    await send(CH1, 53, 64);
    await send(CH1, 54, 64);
    await send(CH1, 55, 64);

    console.log('\nBypass, CC102');
    await send(CH1, 102, 0);
    check('0 bypasses', await bypassed(), true);
    await send(CH1, 102, 127);
    check('127 engages', await bypassed(), false);
    await send(CH1, 102, 63);
    check('63 is still the bypassed half', await bypassed(), true);
    await send(CH1, 102, 64);
    check('64 is already the engaged half', await bypassed(), false);

    console.log('\nChannel filter');
    await setChannel(3);
    await send(CH1, 50, 0);
    check('a message on another channel is ignored', (await pots())[0], 1);
    await send(CH3, 50, 0);
    check('a message on the chosen channel is taken', (await pots())[0], 0);
    await setChannel(0);
    await send(CH7, 50, 127);
    check('omni takes any channel', (await pots())[0], 1);

    console.log('\nMessages that must be ignored');
    const quiet = await pots();
    await send(0xF8);                 // clock
    await send(0xFE);                 // active sensing
    await send(0x90, 60, 100);        // note on
    await send(0xB0, 7, 0);           // unmapped CC
    await send(0xB0);                 // truncated
    check('clock, notes and unmapped CCs change nothing', await pots(), quiet);

    console.log('\nDevices');
    await page.evaluate(() => midiConnect());
    check('every input is listed, plus an all-inputs entry',
        await page.evaluate(() => [...document.getElementById('midiDevice').options]
            .map(o => o.textContent)),
        ['All inputs', 'Fake Controller', 'Second Device']);
    check('all inputs are listened to by default',
        await page.evaluate(() => [...window.__fakeMidi.inputs.values()]
            .map(i => typeof i.onmidimessage)),
        ['function', 'function']);

    await page.evaluate(() => {
        document.getElementById('midiDevice').value = 'Second Device';
        midiOnDeviceChange();
    });
    check('choosing one input stops the others being heard',
        await page.evaluate(() => [...window.__fakeMidi.inputs.values()]
            .map(i => typeof i.onmidimessage)),
        ['object', 'function']);

    await page.evaluate(() => window.__fakeMidi.inputs.get('b')
        .onmidimessage({data: new Uint8Array([0xB0, 50, 0])}));
    check('a message from the chosen input is taken', (await pots())[0], 0);

    // Unplug it. The selection has to survive, or a controller that browns out
    // for a moment comes back silent.
    await page.evaluate(() => {
        window.__fakeMidi.inputs.delete('b');
        window.__fakeMidi.onstatechange();
    });
    check('an unplugged device stays selected, and says so',
        await page.evaluate(() => {
            const sel = document.getElementById('midiDevice');
            return [sel.value, sel.options[sel.selectedIndex].textContent,
                document.getElementById('midiLine').textContent];
        }),
        ['Second Device', 'Second Device (not connected)', 'Second Device is not connected']);

    await page.evaluate(() => {
        window.__fakeMidi.inputs.set('b', window.__fakeMidiMake('b2', 'Second Device'));
        window.__fakeMidi.onstatechange();
    });
    await page.evaluate(() => window.__fakeMidi.inputs.get('b')
        .onmidimessage({data: new Uint8Array([0xB0, 50, 127])}));
    check('it is heard again when it comes back', (await pots())[0], 1);

    console.log('\nSliders');
    await page.evaluate(() => {
        document.getElementById('simPot0').value = '25';
        simSendPots();
    });
    check('a slider still drives its pot', (await pots())[0], 0.25);

    await browser.close();

    console.log('\n' + (failures ? failures + ' failing' : 'all tests passed'));
    process.exit(failures ? 1 : 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
