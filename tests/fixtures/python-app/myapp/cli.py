import click

from myapp.core import load_config
from myapp import core


@click.group()
def cli():
    pass


@cli.command()
def show_config():
    click.echo(core.load_config("app.yaml"))


@cli.command("serve")
def run_server():
    from myapp.api import routes

    routes.start()


@cli.command()
def check():
    load_config("app.yaml")


@cli.command(name="export")
def export_cmd():
    pass


@cli.command()
def reset():
    pass
