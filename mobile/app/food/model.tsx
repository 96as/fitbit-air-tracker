import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { Button, Card, H2, Muted } from '../../src/components/ui';
import { colors } from '../../src/theme';
import { useFoodStore } from '../../src/foodStore';
import {
  cancelModelDownload,
  deleteModel,
  downloadModel,
  hasRoomFor,
  isModelInstalled,
  isOnCellular,
  pauseModelDownload,
  remainingBytes,
  useModelRuntime,
} from '../../src/services/food/modelManager';
import { VISION_MODELS, fmtBytes, modelBytes, type VisionModel } from '../../src/services/food/models';
import { ProgressBar, foodStyles, foodHeader } from '../../src/services/food/ui';

export default function ModelScreen() {
  const settings = useFoodStore((s) => s.settings);
  const setSettings = useFoodStore((s) => s.setSettings);
  const installed = useFoodStore((s) => s.installed);
  const pending = useFoodStore((s) => s.pendingDownload);
  const runtime = useModelRuntime();
  const busy = runtime.status === 'downloading' || runtime.status === 'verifying';

  const start = async (m: VisionModel) => {
    if (!hasRoomFor(m)) {
      Alert.alert('Not enough free space', `This model needs ${fmtBytes(remainingBytes(m))} plus some headroom. Free up space and try again.`);
      return;
    }
    const go = () => {
      setSettings({ modelId: m.id });
      void downloadModel(m.id);
    };
    if (await isOnCellular()) {
      Alert.alert('You are on mobile data', `This download is ${fmtBytes(remainingBytes(m))}. Wi-Fi is recommended.`, [
        { text: 'Wait for Wi-Fi', style: 'cancel' },
        { text: 'Download anyway', onPress: go },
      ]);
      return;
    }
    go();
  };

  return (
    <ScrollView contentContainerStyle={st.content}>
      <Stack.Screen options={{ ...foodHeader, title: 'Food recognition model' }} />
      <Card>
        <Text style={foodStyles.itemTitle}>Private by design</Text>
        <Muted>
          Food recognition runs entirely on this iPhone with an open model. Your photos are never uploaded. The only network use is this one-time model
          download from Hugging Face, which you start yourself. The file is verified (SHA-256) and excluded from iCloud backup.
        </Muted>
      </Card>

      {VISION_MODELS.map((m) => (
        <ModelCard
          key={m.id}
          model={m}
          selected={settings.modelId === m.id}
          ready={installed[m.id] !== undefined && isModelInstalled(m.id)}
          downloadingThis={runtime.modelId === m.id && busy}
          pausedThis={pending?.modelId === m.id && !busy}
          runtime={runtime}
          anyBusy={busy}
          onDownload={() => void start(m)}
          onSelect={() => setSettings({ modelId: m.id })}
        />
      ))}

      <H2>Good to know</H2>
      <Muted>
        • Analysis loads the model only while it looks at a photo, then frees the memory.{'\n'}• Keep the app open during analysis (~10–40 s).{'\n'}• If
        iOS closes the app while analysing, switch to the lighter model.{'\n'}• Estimates from photos can be off by ±40%; the review screen lets you fix
        portions.
      </Muted>
    </ScrollView>
  );
}

function ModelCard(props: {
  model: VisionModel;
  selected: boolean;
  ready: boolean;
  downloadingThis: boolean;
  pausedThis: boolean;
  runtime: ReturnType<typeof useModelRuntime.getState>;
  anyBusy: boolean;
  onDownload: () => void;
  onSelect: () => void;
}) {
  const { model: m, ready, runtime } = props;
  const pct = runtime.bytesTotal > 0 ? runtime.bytesDone / runtime.bytesTotal : 0;
  return (
    <Card style={props.selected ? { borderColor: colors.accent } : undefined}>
      <View style={foodStyles.rowBetween}>
        <Text style={[foodStyles.itemTitle, { flex: 1 }]}>{m.title}</Text>
        <Text style={{ color: ready ? colors.ok : colors.muted, fontWeight: '700' }}>{ready ? (props.selected ? 'In use' : 'Installed') : ''}</Text>
      </View>
      <Muted>{m.summary}</Muted>
      <Text style={st.meta}>
        Download {fmtBytes(modelBytes(m))} · needs ~{m.approxPeakRamGB} GB RAM while analysing · License {m.license}
      </Text>

      {props.downloadingThis && (
        <>
          <ProgressBar value={pct} />
          <Text style={st.meta}>
            {runtime.status === 'verifying'
              ? 'Verifying file integrity…'
              : `${fmtBytes(runtime.bytesDone)} of ${fmtBytes(runtime.bytesTotal)} (${Math.round(pct * 100)}%)`}
          </Text>
          {runtime.status === 'downloading' && <Button title="Pause" kind="secondary" onPress={() => void pauseModelDownload()} />}
        </>
      )}
      {!props.downloadingThis && runtime.modelId === m.id && runtime.status === 'error' && (
        <Text style={[st.meta, { color: colors.danger }]}>{runtime.message}</Text>
      )}
      {!props.downloadingThis && runtime.modelId === m.id && runtime.message && runtime.status === 'idle' && <Text style={st.meta}>{runtime.message}</Text>}

      {!ready && !props.downloadingThis && (
        <>
          <Button
            title={props.pausedThis ? 'Resume download' : `Download (${fmtBytes(remainingBytes(m))})`}
            onPress={props.onDownload}
            disabled={props.anyBusy}
          />
          {props.pausedThis && <Button title="Cancel download" kind="secondary" onPress={() => cancelModelDownload(m.id)} />}
          {!props.pausedThis && <Muted>Wi-Fi recommended. You can pause and resume.</Muted>}
        </>
      )}
      {ready && !props.selected && <Button title="Use this model" kind="secondary" onPress={props.onSelect} />}
      {ready && (
        <Button
          title="Delete from phone"
          kind="danger"
          onPress={() =>
            Alert.alert('Delete model?', `Frees ${fmtBytes(modelBytes(m))}. Photo recognition stops until you download it again.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => deleteModel(m.id) },
            ])
          }
        />
      )}
    </Card>
  );
}

const st = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  meta: { color: colors.muted, fontSize: 12, marginTop: 6 },
});
