import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { Button, Card, Muted } from '../../src/components/ui';
import { colors } from '../../src/theme';
import { newDraft, todayLocal, useFoodStore } from '../../src/foodStore';
import {
  AnalysisFailedError,
  AnalysisInterruptedError,
  ModelNotReadyError,
  analyzeMeal,
  type AnalysisStage,
} from '../../src/services/food/analyzeMeal';
import { draftFromAnalysis } from '../../src/services/food/draft';
import { isModelInstalled } from '../../src/services/food/modelManager';
import { modelById } from '../../src/services/food/models';
import { foodStyles, foodHeader } from '../../src/services/food/ui';

type Picked = { uri: string; width: number; height: number };

const STAGE_TEXT: Record<AnalysisStage, string> = {
  preparing: 'Preparing the photo…',
  'loading-model': 'Loading the on-device model…',
  looking: 'Looking at your plate…',
  retrying: 'Almost there — asking again for a clean answer…',
  done: 'Done',
};

export default function PhotoScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ date?: string }>();
  const date = params.date ?? todayLocal();
  const modelId = useFoodStore((s) => s.settings.modelId);
  const setDraft = useFoodStore((s) => s.setDraft);
  const [photo, setPhoto] = useState<Picked | undefined>(undefined);
  const [stage, setStage] = useState<AnalysisStage | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const busy = stage !== undefined && stage !== 'done';
  const ready = isModelInstalled(modelId);
  const pickedUris = useRef<string[]>([]);

  // The picker's temporary copies stay in the app cache only; remove them when leaving.
  useEffect(
    () => () => {
      for (const uri of pickedUris.current) {
        try {
          const f = new File(uri);
          if (f.exists) f.delete();
        } catch {
          // ignore
        }
      }
    },
    [],
  );

  const pick = async (source: 'camera' | 'library') => {
    setError(undefined);
    const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError(source === 'camera' ? 'Camera permission is off. Enable it in iOS Settings ▸ SmartWake.' : 'Photo access is off. Enable it in iOS Settings ▸ SmartWake.');
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, exif: false, allowsEditing: false };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    pickedUris.current.push(a.uri);
    const p = { uri: a.uri, width: a.width, height: a.height };
    setPhoto(p);
    if (ready) void run(p);
  };

  const run = async (p: Picked) => {
    setError(undefined);
    try {
      const analysis = await analyzeMeal(p, modelId, setStage);
      setDraft(draftFromAnalysis(analysis, date));
      router.replace('/food/review');
    } catch (err) {
      setStage(undefined);
      if (err instanceof ModelNotReadyError) setError(err.message);
      else if (err instanceof AnalysisInterruptedError) setError(`${err.message} Keep the app open while it looks at the photo.`);
      else if (err instanceof AnalysisFailedError) setError(`${err.message} You can add the foods by hand instead.`);
      else setError(`Something went wrong on the device: ${err instanceof Error ? err.message : String(err)}. You can add the foods by hand instead.`);
    }
  };

  const manual = () => {
    setDraft(newDraft('manual', date));
    router.replace('/food/review');
  };

  return (
    <ScrollView contentContainerStyle={st.content}>
      <Stack.Screen options={{ ...foodHeader, title: 'Meal photo' }} />
      {!ready && (
        <Card>
          <Text style={foodStyles.itemTitle}>Food recognition is not downloaded</Text>
          <Muted>
            To recognise food from photos the app needs the on-device model ({modelById(modelId).title}). It runs entirely on this iPhone — your photos
            never leave it. You can still log meals by hand.
          </Muted>
          <Button title="Get the model" onPress={() => router.push('/food/model')} />
        </Card>
      )}

      {photo ? (
        <Image source={{ uri: photo.uri }} style={[st.preview, { aspectRatio: photo.width / Math.max(1, photo.height) }]} resizeMode="cover" />
      ) : (
        <Card>
          <Text style={foodStyles.itemTitle}>Snap your plate</Text>
          <Muted>Shoot from above with the whole plate in frame. A hand, fork or the plate edge helps the model judge portion size.</Muted>
        </Card>
      )}

      {busy && (
        <View style={st.busy}>
          <ActivityIndicator color={colors.accent} />
          <Text style={st.busyText}>{STAGE_TEXT[stage!]}</Text>
        </View>
      )}

      {error && (
        <View style={foodStyles.caveat}>
          <Text style={foodStyles.caveatText}>{error}</Text>
        </View>
      )}

      {!busy && (
        <>
          <Button title="📷  Take photo" onPress={() => void pick('camera')} />
          <Button title="Choose from library" kind="secondary" onPress={() => void pick('library')} />
          {photo && ready && error && <Button title="Try again" kind="secondary" onPress={() => void run(photo)} />}
          <Button title="Enter foods manually" kind="secondary" onPress={manual} />
        </>
      )}

      <Muted>{'\n'}Analysis happens on the phone, in the foreground, and takes roughly 10–40 s. Photo estimates can be off by ±40%.</Muted>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  preview: { width: '100%', borderRadius: 14, marginTop: 10, backgroundColor: colors.panel, maxHeight: 420 },
  busy: { flexDirection: 'row', alignItems: 'center', marginTop: 14, gap: 10 },
  busyText: { color: colors.text, fontSize: 15 },
});
