"""Синтезирует звук колокольчика для напоминаний: assets/bell.wav.

Два лёгких удара (соль и до), у каждого — негармоничные обертоны
настоящего колокольчика с разным временем затухания.
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44100
LENGTH = 1.9  # секунды

# (отношение к основной частоте, громкость, время затухания в секундах)
PARTIALS = [
    (1.00, 1.00, 1.10),
    (2.00, 0.45, 0.70),
    (2.76, 0.32, 0.45),
    (3.90, 0.18, 0.30),
    (5.40, 0.10, 0.18),
    (0.50, 0.12, 0.90),
]

# (время удара, частота, громкость)
STRIKES = [
    (0.00, 1568.0, 1.00),  # G6
    (0.16, 2093.0, 0.85),  # C7
]


def sample(t: float) -> float:
    value = 0.0
    for start, freq, gain in STRIKES:
        dt = t - start
        if dt < 0:
            continue
        attack = min(1.0, dt / 0.004)
        for ratio, amp, decay in PARTIALS:
            # Лёгкое биение, как у реального металла.
            beat = 1 + 0.03 * math.sin(2 * math.pi * 3.1 * dt)
            value += gain * amp * attack * math.exp(-dt / decay) * beat * math.sin(2 * math.pi * freq * ratio * dt)
    return value


def main() -> None:
    frames = [sample(i / RATE) for i in range(int(RATE * LENGTH))]
    peak = max(abs(v) for v in frames)
    # Плавно гасим хвост, чтобы не было щелчка в конце.
    fade = int(RATE * 0.15)
    for i in range(fade):
        frames[-1 - i] *= i / fade

    out = Path(__file__).resolve().parent.parent / "assets" / "bell.wav"
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(v / peak * 0.55 * 32767)) for v in frames))
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
