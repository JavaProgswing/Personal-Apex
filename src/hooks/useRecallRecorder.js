import { useEffect, useRef } from "react";
import api from "../lib/api.js";

// While a Recall session is armed WITH audio, capture system-audio loopback via
// getDisplayMedia (the main process grants it with audio:'loopback') and stream
// ~15s base64 chunks to main. Lives at app root so it keeps running regardless
// of which page is open. Only the audio track is kept; screenshots come from the
// main process. No media is persisted — main transcribes and discards.

function abToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

export default function useRecallRecorder() {
  const rec = useRef(null);          // { recorder, stream, secTimer }
  const starting = useRef(false);

  useEffect(() => {
    let mounted = true;

    function stopCapture() {
      const r = rec.current;
      rec.current = null;
      if (!r) return;
      try { clearInterval(r.secTimer); } catch {}
      try { if (r.recorder.state !== "inactive") r.recorder.stop(); } catch {}
      try { r.stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { api.recall.audioState?.({ capturing: false }); } catch {}
    }

    async function startCapture() {
      if (rec.current || starting.current) return;
      if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === "undefined") {
        api.recall.audioState?.({ capturing: false, error: "audio capture unsupported here" });
        return;
      }
      starting.current = true;
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream.getVideoTracks().forEach((t) => t.stop()); // keep audio only
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks.length) {
          stream.getTracks().forEach((t) => t.stop());
          api.recall.audioState?.({ capturing: false, error: "no system audio track" });
          return;
        }
        // Prefer ogg/opus: Gemini accepts audio/ogg natively, so when cloud
        // recap is on, Recall can send the raw file and skip Whisper. Falls
        // back to webm (transcribe-only) where the recorder can't do ogg.
        const mime = ["audio/ogg;codecs=opus", "audio/ogg", "audio/webm;codecs=opus", "audio/webm"]
          .find((m) => MediaRecorder.isTypeSupported(m)) || "audio/webm";
        const recorder = new MediaRecorder(new MediaStream(audioTracks), {
          mimeType: mime,
          audioBitsPerSecond: 32000,
        });
        recorder.ondataavailable = async (e) => {
          if (!e.data || e.data.size === 0) return;
          try { api.recall.pushAudio(abToBase64(await e.data.arrayBuffer())); } catch {}
        };
        recorder.start(5000); // a chunk every 5s (steady, small tail on stop)
        const startMs = Date.now();
        const secTimer = setInterval(() => {
          api.recall.audioState?.({ capturing: true, mime, seconds: Math.round((Date.now() - startMs) / 1000) });
        }, 10000);
        rec.current = { recorder, stream, secTimer };
        api.recall.audioState?.({ capturing: true, mime, seconds: 0 });
        // OS-level "stop sharing" → tear down cleanly.
        audioTracks[0].addEventListener("ended", stopCapture);
      } catch (e) {
        api.recall.audioState?.({ capturing: false, error: (e && e.message) || "capture denied" });
      } finally {
        starting.current = false;
      }
    }

    function apply(st) {
      if (!mounted) return;
      // Stop on session end OR the ending grace (so the recorder flushes its
      // final chunk while main still accepts audio).
      const want = !!(st && st.active && st.audio && !st.ending);
      if (want && !rec.current) startCapture();
      else if (!want && rec.current) stopCapture();
    }

    api.recall?.status?.().then(apply).catch(() => {});
    const off = api.recall?.onUpdate?.(apply);
    return () => { mounted = false; if (off) off(); stopCapture(); };
  }, []);
}
