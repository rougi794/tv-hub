// Minimal typings for the YouTube IFrame Player API (loaded at runtime from youtube.com/iframe_api).
interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getIframe(): HTMLIFrameElement;
  unloadModule(name: string): void;
  destroy(): void;
}

interface YTEvent { target: YTPlayer; data: number }

interface Window {
  YT?: { Player: new (elementId: string, options: Record<string, unknown>) => YTPlayer };
  onYouTubeIframeAPIReady?: () => void;
  /** Set by the TV Hub shim; absent when the page runs inside Fully Kiosk. */
  tvHub?: { native: boolean };
}
