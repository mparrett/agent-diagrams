import argparse

import helpers
from myapp import cli


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers()
    sub.add_parser("migrate")
    sub.add_parser("seed")
    parser.parse_args()
    print(helpers.banner())
    cli.cli()


if __name__ == "__main__":
    main()
