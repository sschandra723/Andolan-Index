"""python -m andolan <command>   (validate | collect | ai | curate | archive | build)"""
import importlib
import sys

COMMANDS = {"validate": "validate", "collect": "collect", "ai": "ai", "curate": "curate", "archive": "archive", "build": "build"}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        return 2
    module = importlib.import_module(f"andolan.{COMMANDS[sys.argv[1]]}")
    return module.main(sys.argv[2:])


if __name__ == "__main__":
    sys.exit(main())
