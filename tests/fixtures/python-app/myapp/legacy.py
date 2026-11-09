# Climbs above the top-level package: Python refuses this import, so the
# importer must not draw it as an edge to the top-level settings module.
from .. import settings
