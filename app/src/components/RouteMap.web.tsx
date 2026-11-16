import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { MAP_URL } from '@/lib/api';
import { mapState, parseMapMessage, type RouteMapProps } from './mapShared';

/** Веб: та же страница карты, что и на телефонах, в iframe. */
export function RouteMap(props: RouteMapProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const handlers = useRef(props);
  const state = JSON.stringify(mapState(props));

  useEffect(() => {
    handlers.current = props;
  });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== 'string') return;
      const msg = parseMapMessage(e.data);
      if (msg?.type === 'ready') setReady(true);
      else if (msg?.type === 'press') handlers.current.onPress?.({ lat: msg.lat, lng: msg.lng });
      else if (msg?.type === 'marker') handlers.current.onMarkerPress?.(msg.id);
      else if (msg?.type === 'routes') handlers.current.onRoutesPress?.(msg.ids);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ type: 'render', state: JSON.parse(state) }),
      new URL(MAP_URL).origin,
    );
  }, [ready, state]);

  return (
    <View style={[styles.box, props.style]}>
      <iframe
        ref={frame}
        src={MAP_URL}
        title="Карта маршрута"
        style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ box: { flex: 1, overflow: 'hidden', backgroundColor: '#e8e4d9' } });
