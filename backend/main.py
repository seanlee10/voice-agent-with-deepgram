import asyncio
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from typing import List
from assistant import Assistant

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins='*',
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

@app.head('/health')
@app.get('/health')
def health_check():
    return 'ok'

@app.websocket('/listen')
async def websocket_listen(websocket: WebSocket):
    await websocket.accept()
    assistant = Assistant(websocket)
    try:
        await asyncio.wait_for(assistant.run(), timeout=300)
    except TimeoutError:
        print('Connection timeout')

