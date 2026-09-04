"""Python fixture with symbols and imports."""

import os
from pathlib import Path

CONSTANT = 42


def fixture_function(value):
    return value + CONSTANT


class FixtureWidget:
    def render(self):
        return Path(os.getcwd())
