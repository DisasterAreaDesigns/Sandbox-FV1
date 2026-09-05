// The unsaved-changes guard.
//
//     npm run test:page
//
// The app asks before you close a tab that has a program in the editor. That
// prompt is the only thing standing between an unsaved algorithm and a stray
// Cmd-W, and when it fails it fails silently: a beforeunload handler that
// throws looks exactly like one that decided not to object, so the window
// simply closes.
//
// It did fail, for any page whose editor never loaded. hasEditorContent() in
// ui.js delegated to window.hasEditorContent, which -- a top-level function
// declaration being already a property of window -- was itself until monaco.js
// replaced it from inside the Monaco load callback. With the CDN unreachable
// that callback never runs, the call recursed until the stack gave out, and the
// RangeError escaped before preventDefault.
//
// So both halves are checked: the editor loaded, and the editor never loading.

const puppeteer = require('puppeteer');
const path = require('path');

const PAGE = 'file://' + path.resolve(__dirname, '../Assembler/index.html');
const MONACO_CDN = 'cdnjs.cloudflare.com';

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

// Dispatching the event is the honest way to ask "would this page object?".
// A cancelled beforeunload is exactly what makes the browser put up its dialog.
const wouldPrompt = (page) => page.evaluate(() => {
    const ev = new Event('beforeunload', {cancelable: true});
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
});

async function withPage(browser, {blockCdn}, fn) {
    const page = await browser.newPage();
    if (blockCdn) {
        await page.setRequestInterception(true);
        page.on('request', (r) =>
            r.url().includes(MONACO_CDN) ? r.abort() : r.continue());
    }
    await page.goto(PAGE, {waitUntil: 'domcontentloaded', timeout: 30000});
    try {
        await fn(page);
    } finally {
        await page.close();
    }
}

const editorReady = (page, timeout) => page.waitForFunction(
    () => typeof editor !== 'undefined' && editor && typeof editor.getValue === 'function',
    {timeout});

async function run() {
    const browser = await puppeteer.launch({headless: 'new'});

    console.log('\nWith the editor loaded');
    let skipped = false;
    await withPage(browser, {blockCdn: false}, async (page) => {
        try {
            await editorReady(page, 20000);
        } catch (e) {
            console.log('  skip  Monaco did not load, so there is no editor to fill');
            skipped = true;
            return;
        }

        await page.evaluate(() => editor.setValue(''));
        check('an empty editor closes without asking', await wouldPrompt(page), false);

        await page.evaluate(() => editor.setValue('   \n\t\n'));
        check('whitespace is not work worth saving', await wouldPrompt(page), false);

        await page.evaluate(() => editor.setValue('sof 0,0\nwrax dacl,0\n'));
        check('a program in the editor asks before closing', await wouldPrompt(page), true);
    });

    console.log('\nWith the Monaco CDN unreachable');
    await withPage(browser, {blockCdn: true}, async (page) => {
        // Give the loader long enough to have failed.
        await new Promise((r) => setTimeout(r, 2000));

        check('the content check answers instead of throwing',
            await page.evaluate(() => {
                try { return typeof hasEditorContent(); }
                catch (err) { return err.constructor.name; }
            }),
            'boolean');

        // Nothing was ever typed, because there is no editor to type into, so
        // the honest answer is that there is nothing to lose. What must not
        // happen is the handler dying on the way to that answer.
        check('and closing is not blocked by a thrown handler',
            await wouldPrompt(page), false);

        check('no uncaught error reached the console',
            await page.evaluate(() => {
                let seen = null;
                window.addEventListener('error', (e) => { seen = e.message; });
                window.dispatchEvent(new Event('beforeunload', {cancelable: true}));
                return seen;
            }),
            null);
    });

    await browser.close();

    if (skipped) console.log('\n(the loaded-editor cases were skipped)');
    console.log(failures ? `\n${failures} failed` : '\nall tests passed');
    process.exit(failures ? 1 : 0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
