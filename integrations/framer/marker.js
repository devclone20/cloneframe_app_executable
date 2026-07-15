// Runs at document_start on the CLONE FRAME HUB origin (127.0.0.1 / localhost).
// Announces to the page that the Framer extension is active, so the in-app browser
// can direct-iframe sites that would otherwise block framing (their X-Frame-Options /
// CSP frame-ancestors are stripped by rules.json for sub_frame requests). Content
// scripts share the DOM with the page, so the page reads document.documentElement.dataset.cfFramer.
try { document.documentElement.dataset.cfFramer = '1'; } catch (e) {}
