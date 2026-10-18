#!/usr/bin/env python3
"""Generate JSON test fixtures for the installer's hook-merge tests.

Run from this folder:  python3 -I gen_fixtures.py

Writes settings/ (Claude Code settings.json variants) and codex/ (Codex
hooks.json variants). Every file is written as exact bytes, so BOM and CRLF
survive. Output is deterministic: running twice gives identical files.
Stdlib only.
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BOM = b"\xef\xbb\xbf"


def lines(*parts):
    """Join lines with LF and end with a single LF."""
    return "\n".join(parts) + "\n"


def crlf(text):
    return text.replace("\n", "\r\n")


def reindent(text, unit):
    """Re-indent a 2-space JSON document, one `unit` per nesting level."""
    out = []
    for line in text.split("\n"):
        stripped = line.lstrip(" ")
        level = (len(line) - len(stripped)) // 2
        out.append(unit * level + stripped)
    return "\n".join(out)


def to_bytes(data):
    return data.encode("utf-8") if isinstance(data, str) else data


def write(folder, name, data):
    path = os.path.join(HERE, folder, name)
    with open(path, "wb") as fh:
        fh.write(to_bytes(data))


# ---------------------------------------------------------------------------
# Shared content
# ---------------------------------------------------------------------------

BASE2 = lines(
    "{",
    '  "model": "claude-sonnet-5",',
    '  "env": {',
    '    "DEBUG_LEVEL": "2",',
    '    "CLAUDE_CODE_ENABLE_TELEMETRY": "0"',
    "  },",
    '  "permissions": {',
    '    "allow": [',
    '      "Bash(npm test)",',
    '      "Read(./src/**)"',
    "    ]",
    "  }",
    "}",
)

MINIFIED = (
    '{"model":"claude-sonnet-5","env":{"DEBUG_LEVEL":"2"},'
    '"permissions":{"allow":["Bash(npm test)"]},'
    '"theme":"dark","includeCoAuthoredBy":false}'
)

STOP_GROUP = lines(
    "    \"Stop\": [",
    "      {",
    "        \"hooks\": [",
    "          {",
    "            \"type\": \"command\",",
    "            \"command\": \"/usr/local/bin/x.sh\",",
    "            \"timeout\": 5",
    "          }",
    "        ]",
    "      }",
    "    ]",
)

# Codex hooks.json examples use the same hook shape plus an optional description.
CODEX_STOP = lines(
    "{",
    '  "description": "Existing user hooks",',
    '  "hooks": {',
    '    "Stop": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/codex-stop.sh",',
    '            "timeout": 5',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
)

CODEX_MANY = lines(
    "{",
    '  "description": "Many events",',
    '  "hooks": {',
    '    "PreToolUse": [',
    "      {",
    '        "matcher": "Bash",',
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/pre.sh",',
    '            "timeout": 3',
    "          }",
    "        ]",
    "      }",
    "    ],",
    '    "PostToolUse": [',
    "      {",
    '        "matcher": "Edit|Write",',
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/post.sh"',
    "          }",
    "        ]",
    "      }",
    "    ],",
    '    "SessionStart": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/start.sh"',
    "          }",
    "        ]",
    "      }",
    "    ],",
    '    "UserPromptSubmit": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/prompt.sh"',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
)

CODEX_PERMREQ = lines(
    "{",
    '  "hooks": {',
    '    "PermissionRequest": [',
    "      {",
    '        "matcher": "Bash",',
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/usr/local/bin/perm.sh",',
    '            "timeout": 10',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
)

OTHERTOOL_SETTINGS_HOOKS = lines(
    "{",
    '  "hooks": {',
    '    "SessionStart": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/Users/someone/.othertool/plugin/scripts/session-start.sh",',
    '            "timeout": 5,',
    '            "async": true',
    "          }",
    "        ]",
    "      }",
    "    ],",
    '    "SessionEnd": [',
    "      {",
    '        "hooks": [',
    "          {",
    '            "type": "command",',
    '            "command": "/Users/someone/.othertool/plugin/scripts/session-end.sh",',
    '            "timeout": 5',
    "          }",
    "        ]",
    "      }",
    "    ]",
    "  }",
    "}",
)

# ---------------------------------------------------------------------------
# settings/ : ok- files (must parse as strict JSON with an object at top level)
# ---------------------------------------------------------------------------

deep_nested = '{"a":' * 60 + "1" + "}" * 60

OK_SETTINGS = {
    "empty-object": "{}",
    "empty-object-nl": "{}\n",
    "empty-object-spaced": "{\n}\n",
    "minified": MINIFIED,
    "indent2": BASE2,
    "indent4": reindent(BASE2, "    "),
    "tab-indent": reindent(BASE2, "\t"),
    "crlf": crlf(BASE2),
    "bom": BOM + to_bytes(BASE2),
    "bom-crlf": BOM + to_bytes(crlf(BASE2)),
    "no-trailing-newline": BASE2.rstrip("\n"),
    "hooks-empty-object": lines(
        "{",
        '  "theme": "dark",',
        '  "hooks": {}',
        "}",
    ),
    "hooks-event-empty-array": lines(
        "{",
        '  "hooks": {',
        '    "Stop": []',
        "  }",
        "}",
    ),
    "hooks-existing-stop": lines(
        "{",
        '  "theme": "dark",',
        '  "hooks": {',
        STOP_GROUP,
        "  }",
        "}",
    ),
    "hooks-existing-permissionrequest": lines(
        "{",
        '  "hooks": {',
        '    "PermissionRequest": [',
        "      {",
        '        "matcher": "Bash",',
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "/usr/local/bin/perm.sh",',
        '            "timeout": 10',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
    ),
    "hooks-many-events": lines(
        "{",
        '  "hooks": {',
        '    "PreToolUse": [',
        "      {",
        '        "matcher": "Bash",',
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "/usr/local/bin/pre-bash.sh"',
        "          }",
        "        ]",
        "      }",
        "    ],",
        '    "PostToolUse": [',
        "      {",
        '        "matcher": "Edit|Write",',
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "/usr/local/bin/post-edit.sh",',
        '            "timeout": 8',
        "          }",
        "        ]",
        "      }",
        "    ],",
        '    "SessionStart": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "/usr/local/bin/session.sh"',
        "          }",
        "        ]",
        "      }",
        "    ],",
        '    "UserPromptSubmit": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "/usr/local/bin/prompt.sh"',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
    ),
    "hooks-plugin-style": lines(
        "{",
        '  "enabledPlugins": {',
        '    "x@y": true',
        "  },",
        '  "hooks": {',
        '    "PostToolUse": [',
        "      {",
        '        "matcher": "Write",',
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh",',
        '            "timeout": 5,',
        '            "async": true',
        "          }",
        "        ]",
        "      }",
        "    ],",
        '    "Stop": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "command",',
        '            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh stop"',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
    ),
    "hooks-othertool-style": OTHERTOOL_SETTINGS_HOOKS,
    "hooks-http-type": lines(
        "{",
        '  "hooks": {',
        '    "Stop": [',
        "      {",
        '        "hooks": [',
        "          {",
        '            "type": "http",',
        '            "url": "http://localhost:9/x",',
        '            "timeout": 2',
        "          }",
        "        ]",
        "      }",
        "    ]",
        "  }",
        "}",
    ),
    "statusline-other": lines(
        "{",
        '  "statusLine": {',
        '    "type": "command",',
        '    "command": "~/.claude/my-status.sh",',
        '    "padding": 0',
        "  }",
        "}",
    ),
    "statusline-othertool": lines(
        "{",
        '  "statusLine": {',
        '    "type": "command",',
        '    "command": "/Users/someone/.local/bin/othertool-statusline"',
        "  }",
        "}",
    ),
    "statusline-with-refresh": lines(
        "{",
        '  "statusLine": {',
        '    "type": "command",',
        '    "command": "/Users/someone/.local/bin/othertool-statusline",',
        '    "refreshInterval": 5,',
        '    "padding": 1',
        "  }",
        "}",
    ),
    "statusline-and-hooks": lines(
        "{",
        '  "statusLine": {',
        '    "type": "command",',
        '    "command": "~/.claude/my-status.sh",',
        '    "padding": 0',
        "  },",
        '  "hooks": {',
        STOP_GROUP,
        "  }",
        "}",
    ),
    "duplicate-top-level-key": lines(
        "{",
        '  "model": "claude-haiku-5-5",',
        '  "model": "claude-sonnet-5"',
        "}",
    ),
    "strings-contain-hooks-text": lines(
        "{",
        r'  "note": "text \"hooks\": { inside a string }{ still a string",',
        r'  "brackets": "[{ ]} [[ }} {{",',
        r'  "quoted": "she said \"hi\" and left",',
        r'  "escapedBackslash": "C:\\Users\\x",',
        r'  "unicodeEscape": "\u00e9t\u00e9",',
        r'  "hooksCopy": "\"hooks\": {\"Stop\": []}"',
        "}",
    ),
    "unicode": lines(
        "{",
        '  "nombre": "Jos\u00e9 Mu\u00f1oz",',
        '  "\u65e5\u672c\u8a9e": "\u5024",',
        '  "emoji": "\U0001F680 ready \u2705",',
        '  "escapedInString": "tab:\\t quote:\\\" slash:\\/ uni:\\u00e9",',
        '  "\U0001F4E6": "package"',
        "}",
    ),
    "deeply-nested-other-key": lines(
        "{",
        '  "deep": ' + deep_nested + ",",
        '  "model": "claude-sonnet-5"',
        "}",
    ),
    "numbers-and-literals": lines(
        "{",
        '  "float": 1.5e10,',
        '  "negzero": -0,',
        '  "fraction": -3.25E-2,',
        '  "int": 42,',
        '  "yes": true,',
        '  "no": false,',
        '  "nothing": null',
        "}",
    ),
    "whitespace-only-before-after": (
        "\n\n\n" + BASE2 + "\n\n  \t \n"
    ),
    "hooks-last-key-no-comma-style": reindent(lines(
        "{",
        '  "model": "claude-sonnet-5",',
        '  "env": {',
        '    "DEBUG_LEVEL": "2"',
        "  },",
        '  "hooks": {',
        STOP_GROUP,
        "  }",
        "}",
    ), "    "),
    "hooks-first-key": lines(
        "{",
        '  "hooks": {',
        STOP_GROUP,
        "  },",
        '  "model": "claude-sonnet-5",',
        '  "env": {',
        '    "DEBUG_LEVEL": "2"',
        "  }",
        "}",
    ),
    "mixed-indent-hooks": lines(
        "{",
        '  "model": "claude-sonnet-5",',
        '  "hooks": {',
        '    "Stop": [',
        "        {",
        '            "hooks": [',
        "                {",
        '                    "type": "command",',
        '                    "command": "/usr/local/bin/x.sh",',
        '                    "timeout": 5',
        "                }",
        "            ]",
        "        }",
        "    ]",
        "  }",
        "}",
    ),
    "trailing-commentlike-strings": lines(
        "{",
        '  "note": "// not a comment",',
        '  "block": "/* nope */",',
        '  "url": "https://example.com/*",',
        '  "hooksText": "// comment at end"',
        "}",
    ),
}

# ---------------------------------------------------------------------------
# settings/ : bad- files (must be refused: not strict JSON, or wrong shape)
# ---------------------------------------------------------------------------

BAD_SETTINGS = {
    "trailing-comma": '{"model": "x",}\n',
    "line-comment": lines("{", '  // a comment', '  "model": "x"', "}"),
    "block-comment": '{ /* c */ "model": "x" }\n',
    "truncated": '{"hooks": {"Stop": [{"hooks": [{"type": "command"',
    "top-level-array": '[{"hooks": {}}]\n',
    "top-level-string": '"hello"\n',
    "hooks-is-array": '{"hooks": []}\n',
    "hooks-is-string": '{"hooks": "none"}\n',
    "event-is-object": '{"hooks": {"Stop": {}}}\n',
    "event-is-string": '{"hooks": {"Stop": "x.sh"}}\n',
    "single-quotes": "{'model': 'x'}\n",
    "unquoted-key": '{model: "x"}\n',
    "nan-literal": '{"x": NaN}\n',
    "not-utf8": b'{"x": "\xff"}\n',
    "null-top-level": "null\n",
    # valid for JSON.parse, refused by serde_json: the installer must refuse them up front, because it
    # could not read them back to disconnect
    "lone-surrogate-value": '{"a": "\\ud800"}\n',
    "number-overflow": '{"a": 1e999}\n',
    "deep-nesting-200": '{"a": ' + "[" * 200 + "]" * 200 + "}\n",
}

# An empty or whitespace-only file holds nothing of the user's: the installer treats it as {}.
OK_SETTINGS["empty-zero-bytes"] = b""
OK_SETTINGS["whitespace-only"] = "  \n"
OK_SETTINGS["bom-only"] = BOM
OK_SETTINGS["bom-whitespace"] = BOM + b"  \r\n"

# ---------------------------------------------------------------------------
# codex/ : ok- and bad- files (hooks.json)
# ---------------------------------------------------------------------------

OK_CODEX = {
    "empty-object": "{}",
    "description-only": lines("{", '  "description": "Othertool hooks for Codex"', "}"),
    "hooks-empty": lines("{", '  "hooks": {}', "}"),
    "existing-stop-hook": CODEX_STOP,
    "existing-permissionrequest-with-matcher": CODEX_PERMREQ,
    "many-events-pretty": CODEX_MANY,
    "crlf": crlf(CODEX_STOP),
    "bom": BOM + to_bytes(CODEX_STOP),
    "minified": (
        '{"description":"min","hooks":{"Stop":[{"hooks":['
        '{"type":"command","command":"/usr/local/bin/codex-stop.sh"}'
        "]}]}}"
    ),
}

BAD_CODEX = {
    "truncated": '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "/usr',
    "top-level-array": '[{"hooks": {}}]\n',
    "hooks-is-array": '{"hooks": []}\n',
    "trailing-comma": '{"hooks": {},}\n',
}


def clean_generated(folder, keep):
    """Remove stale ok-/bad- fixtures in a folder that this script no longer makes."""
    target = os.path.join(HERE, folder)
    for name in os.listdir(target):
        if (name.startswith("ok-") or name.startswith("bad-")) and name not in keep:
            os.remove(os.path.join(target, name))


def main():
    settings_names = set()
    for slug, data in OK_SETTINGS.items():
        name = "ok-%s.json" % slug
        settings_names.add(name)
        write("settings", name, data)
    for slug, data in BAD_SETTINGS.items():
        name = "bad-%s.json" % slug
        settings_names.add(name)
        write("settings", name, data)

    codex_names = set()
    for slug, data in OK_CODEX.items():
        name = "ok-%s.json" % slug
        codex_names.add(name)
        write("codex", name, data)
    for slug, data in BAD_CODEX.items():
        name = "bad-%s.json" % slug
        codex_names.add(name)
        write("codex", name, data)

    clean_generated("settings", settings_names)
    clean_generated("codex", codex_names)

    print("settings: %d ok, %d bad" % (len(OK_SETTINGS), len(BAD_SETTINGS)))
    print("codex: %d ok, %d bad" % (len(OK_CODEX), len(BAD_CODEX)))


if __name__ == "__main__":
    main()
