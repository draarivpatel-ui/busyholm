#!/usr/bin/env python3
"""A stand-in taskbar for the geometry test: a dock-type window along one screen edge. The caller
sets its _NET_WM_STRUT_PARTIAL with xprop. Needs python3-tk (Tk 8.6 on X11). Usage:
fakepanel.py <screen_w> <screen_h> <height> <bottom|top>
"""
import sys
import tkinter

sw, sh, h, edge = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
root = tkinter.Tk()
root.title("BHPANEL")
root.attributes("-type", "dock")
y = sh - h if edge == "bottom" else 0
root.geometry(f"{sw}x{h}+0+{y}")
tkinter.Label(root, text="fake panel", bg="#3355aa", fg="white").pack(fill="both", expand=True)
root.mainloop()
