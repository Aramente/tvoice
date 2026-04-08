#!/usr/bin/env node
// Print a fresh VAPID keypair. Rarely needed — tvoice auto-generates one on
// first run — but useful if you want to rotate or to bake keys into an
// environment file.

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('TVOICE_VAPID_PUBLIC=' + keys.publicKey);
console.log('TVOICE_VAPID_PRIVATE=' + keys.privateKey);
console.log('TVOICE_VAPID_SUBJECT=mailto:you@example.com');
