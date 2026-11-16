import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { mediaUrl } from '@/lib/api';
import { colors, radius, space } from '@/lib/theme';

function PlayRow({ playing, title, hint, onPress }: { playing: boolean; title: string; hint?: string; onPress: () => void }) {
  return (
    <Pressable
      role="button"
      aria-label={playing ? `Пауза: ${title}` : `Слушать: ${title}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
    >
      <View style={styles.round}>
        <Ionicons name={playing ? 'pause' : 'play'} size={20} color={colors.white} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function AudioPlayer({ url, title }: { url: string; title: string }) {
  const player = useAudioPlayer(mediaUrl(url));
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (status.didJustFinish) {
      player.pause();
      player.seekTo(0);
    }
  }, [status.didJustFinish, player]);

  return (
    <PlayRow
      title={title}
      playing={status.playing}
      hint={status.duration ? `${clock(status.currentTime)} / ${clock(status.duration)}` : undefined}
      onPress={() => (status.playing ? player.pause() : player.play())}
    />
  );
}

/** Озвучка голосом устройства, когда нет готового mp3. */
export function DeviceVoicePlayer({ text, lang, title }: { text: string; lang: string; title: string }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    return () => {
      Speech.stop();
    };
  }, [text]);

  return (
    <PlayRow
      title={title}
      hint="Голос устройства"
      playing={speaking}
      onPress={() => {
        if (speaking) {
          Speech.stop();
          setSpeaking(false);
          return;
        }
        setSpeaking(true);
        Speech.speak(text, {
          language: lang,
          onDone: () => setSpeaking(false),
          onStopped: () => setSpeaking(false),
          onError: () => setSpeaking(false),
        });
      }}
    />
  );
}

export function VideoPlayer({ url }: { url: string }) {
  const player = useVideoPlayer(mediaUrl(url));
  return <VideoView player={player} style={styles.video} nativeControls contentFit="contain" />;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.forestSoft,
    borderRadius: radius.md,
    padding: space.sm,
  },
  round: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  hint: { fontSize: 13, color: colors.muted, marginTop: 1 },
  video: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.sm, backgroundColor: '#000' },
});
