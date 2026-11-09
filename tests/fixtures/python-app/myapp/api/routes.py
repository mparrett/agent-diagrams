import os

from fastapi import APIRouter

from ..core import load_config

router = APIRouter()


@router.get("/items")
async def list_items():
    return load_config(os.environ["CONFIG"])


@router.post("/items")
async def create_item():
    return {}


def start():
    pass
