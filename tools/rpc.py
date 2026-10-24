#!/usr/bin/env python3
"""Connecteur RPC : relie l'entrée et la sortie standard au socket du dot (./dot rpc).

Le dot doit tourner avec DOT_INTERFACE=rpc. Le protocole est celui de `pi --mode rpc` : un client
qui sait piloter pi en RPC pilote un dot en lançant `./dot rpc` à la place de `pi --mode rpc`.
Les options (--mode, --session…) sont ignorées : la configuration appartient au dot.
"""

import os
import socket
import sys
import threading
from pathlib import Path

SOCKET = Path(os.environ.get("DOT_RPC_SOCKET") or Path(__file__).resolve().parent.parent / "state" / "channel" / "rpc.sock")


def main():
    if not SOCKET.exists():
        sys.exit(f"Pas de socket RPC ({SOCKET}) : le dot tourne-t-il avec DOT_INTERFACE=rpc ? (./dot start)")
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(str(SOCKET))
    except OSError as e:
        sys.exit(f"Connexion au dot impossible : {e}")

    def to_dot():
        try:
            while chunk := sys.stdin.buffer.read1(65536):
                conn.sendall(chunk)
        except OSError:
            pass
        try:
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    threading.Thread(target=to_dot, daemon=True).start()
    out = sys.stdout.buffer
    try:
        while chunk := conn.recv(65536):
            out.write(chunk)
            out.flush()
    except (OSError, BrokenPipeError):
        pass


if __name__ == "__main__":
    main()
