from myapp.api import routes
from myapp.env import bundle


def rebuild():
    bundle()
    routes.start()
