import { Player, log } from '../../src/lib';
import { polyfill } from '../../src/lib/polyfill';
log.setLevel(6);
polyfill.installAll();

const manifestUri = 'https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd';
// Create a Player instance.
const video = document.getElementById('video') as HTMLVideoElement;
const player = new Player();
await player.attach(video);

// Attach player to the window to make it easy to access in the JS console.
// @ts-expect-error
window.player = player;

// Listen for error events.
player.addEventListener('error', onErrorEvent);

// Try to load a manifest.
// This is an asynchronous process.
try {
  await player.load(manifestUri);
  // This runs if the asynchronous load is successful.
  console.log('The video has now been loaded!');
} catch (e) {
  // onError is executed if the asynchronous load fails.
  onError(e);
}

function onErrorEvent(event: any) {
  // Extract the shaka.util.Error object from the event.
  onError(event.detail);
}

function onError(error: any) {
  // Log the error.
  console.error('Error code', error.code, 'object', error);
}
