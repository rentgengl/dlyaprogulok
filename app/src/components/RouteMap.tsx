import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { Linking, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView as RNWebView } from 'react-native-webview';
import { API_URL, MAP_URL } from '@/lib/api';
import { mapState, parseMapMessage, type RouteMapProps } from './mapShared';

/**
 * В типах react-native-webview 14 при TS 6 WebViewProps схлопывается в never,
 * поэтому описываем только те пропсы, которыми пользуемся.
 */
interface WebViewHandle {
  injectJavaScript(script: string): void;
}
const WebView = RNWebView as unknown as ComponentType<{
  ref?: Ref<WebViewHandle>;
  source: { uri: string };
  style?: StyleProp<ViewStyle>;
  javaScriptEnabled?: boolean;
  onShouldStartLoadWithRequest?: (req: { url: string }) => boolean;
  onMessage?: (e: { nativeEvent: { data: string } }) => void;
}>;

/** iOS и Android: страница карты с нашего сервера в WebView. Веб-версия — RouteMap.web.tsx. */
export function RouteMap(props: RouteMapProps) {
  const ref = useRef<WebViewHandle>(null);
  const [ready, setReady] = useState(false);
  const state = JSON.stringify(mapState(props));

  useEffect(() => {
    if (ready) ref.current?.injectJavaScript(`window.__render(${state});true;`);
  }, [ready, state]);

  return (
    <View style={[styles.box, props.style]}>
      <WebView
        ref={ref}
        source={{ uri: MAP_URL }}
        style={styles.box}
        javaScriptEnabled
        onShouldStartLoadWithRequest={(req) => {
          // Ссылка атрибуции открывается в браузере и не уводит карту.
          if (req.url.startsWith(API_URL)) return true;
          Linking.openURL(req.url).catch(() => {});
          return false;
        }}
        onMessage={(e) => {
          const msg = parseMapMessage(e.nativeEvent.data);
          if (msg?.type === 'ready') setReady(true);
          else if (msg?.type === 'press') props.onPress?.({ lat: msg.lat, lng: msg.lng });
          else if (msg?.type === 'marker') props.onMarkerPress?.(msg.id);
          else if (msg?.type === 'routes') props.onRoutesPress?.(msg.ids);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ box: { flex: 1, overflow: 'hidden', backgroundColor: '#e8e4d9' } });
