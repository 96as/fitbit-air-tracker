import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import alarmSound from '../../assets/alarm.wav';

/**
 * Tier-2: the in-app alarm used by Bedside mode. Loops the alarm sound at full
 * volume (also in silent mode, and it keeps playing if the screen locks thanks
 * to the audio background mode) and pulses haptics until stopRinging().
 */

let player: AudioPlayer | null = null;
let hapticTimer: ReturnType<typeof setInterval> | undefined;
const KEEP_AWAKE_TAG = 'bedside';

export async function prepareAudioSession(): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
  });
}

export async function keepScreenAwake(on: boolean): Promise<void> {
  try {
    if (on) await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    else await deactivateKeepAwake(KEEP_AWAKE_TAG);
  } catch {
    /* unsupported — alarm still works */
  }
}

export function isRinging(): boolean {
  return player !== null;
}

export function startRinging(): void {
  if (player) return;
  try {
    player = createAudioPlayer(alarmSound);
    player.loop = true;
    player.volume = 1;
    player.play();
  } catch (err) {
    console.warn('audio failed, haptics only', err);
  }
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  hapticTimer = setInterval(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
  }, 600);
}

export function stopRinging(): void {
  if (hapticTimer) clearInterval(hapticTimer);
  hapticTimer = undefined;
  if (player) {
    try {
      player.pause();
      player.remove();
    } catch {
      /* already released */
    }
    player = null;
  }
}
