# Speaks a film's lines (its film.js) with Kokoro, an open-source text-to-speech model, into
# vo/<id>.wav: the narrator or "you" (stand-ins for your own voice), the coach and Sam.
#
#   pip install kokoro-onnx soundfile
#   (model files from https://github.com/thewh1teagle/kokoro-onnx/releases, model-files-v1.0:
#    kokoro-v1.0.int8.onnx and voices-v1.0.bin, in $KOKORO_DIR, default ~/.cache/kokoro)
#   python3 scripts/demo/launch/tts.py               (the launch film)
#   python3 scripts/demo/launch/tts.py walkthrough   (the walkthrough, ../walkthrough)
import json, os, re, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1:
    HERE = os.path.join(os.path.dirname(HERE), sys.argv[1])
MODELS = os.environ.get('KOKORO_DIR', os.path.expanduser('~/.cache/kokoro'))
VOICES = {
    'narrator': ('af_heart', 1.05, 'en-us'),
    # Your lines in the walkthrough, at about the pace of someone talking to their camera.
    'you': ('af_heart', 1.12, 'en-us'),
    'coach': ('bm_george', 0.98, 'en-gb'),
    'sam': ('am_puck', 1.0, 'en-us'),
}
# The lines live in film.js (one place for the words and their timing).
src = open(os.path.join(HERE, 'film.js'), encoding='utf-8').read()
lines = re.findall(r"\{ id: '(\w+)', who: '(\w+)', at: [\d.]+, text: '([^']*)' \}", src)
k = Kokoro(os.path.join(MODELS, 'kokoro-v1.0.int8.onnx'), os.path.join(MODELS, 'voices-v1.0.bin'))
os.makedirs(os.path.join(HERE, 'vo'), exist_ok=True)
for id_, who, text in lines:
    voice, speed, lang = VOICES[who]
    s, sr = k.create(text.replace('’', "'"), voice=voice, speed=speed, lang=lang)
    a = np.abs(s)
    nz = np.where(a > 0.01 * a.max())[0]
    s = s[max(0, nz[0] - int(0.03 * sr)): nz[-1] + int(0.08 * sr)]
    sf.write(os.path.join(HERE, 'vo', f'{id_}.wav'), s, sr)
    print(id_, who, round(len(s) / sr, 2), 's')
