import { Player } from './lib';
import { polyfill } from './lib/polyfill';

polyfill.installAll();

const manifestUri = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
// Create a Player instance.
const video = document.getElementById('video') as HTMLVideoElement;
const player = new Player();
await player.attach(video);

// Attach player to the window to make it easy to access in the JS console.
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
