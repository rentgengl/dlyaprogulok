import { Platform } from 'react-native';

export const colors = {
  paper: '#F6F1E7',
  card: '#FFFDF8',
  ink: '#1F2A24',
  muted: '#6B7268',
  line: '#E2DBCB',
  forest: '#24483E',
  forestSoft: '#DCE6DF',
  accent: '#C8553D',
  accentSoft: '#F6E2DC',
  gold: '#D9A441',
  white: '#FFFFFF',
};

export const serif = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, "Times New Roman", serif' });

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const radius = { sm: 8, md: 14, lg: 20, pill: 999 };
export const CONTENT_MAX_WIDTH = 720;
