import asyncio
from dataclasses import asdict
import os
import httpx
import re
import string
import boto3
import base64
from starlette.websockets import WebSocketDisconnect, WebSocketState
from deepgram import (
    DeepgramClient, DeepgramClientOptions, LiveTranscriptionEvents, LiveOptions
)
from dotenv import load_dotenv
from contextlib import closing


load_dotenv()
# from app.config import settings
from graph import create_app
# from app.types import Order

AWS_ACCESS_KEY_ID = os.environ["AWS_ACCESS_KEY_ID"]
AWS_SECRET_ACCESS_KEY = os.environ["AWS_SECRET_ACCESS_KEY"]
DEEPGRAM_API_KEY = os.environ["DEEPGRAM_API_KEY"]
DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak?model=aura-luna-en'
SYSTEM_PROMPT = """You are a helpful and enthusiastic assistant. Speak in a human, conversational tone.
Keep your answers as short and concise as possible, like in a conversation, ideally no more than 120 characters.
"""

language = "en"
voice_config = {
    'en': 'Ruth',
    'ko': 'Seoyeon'
}

deepgram_config = DeepgramClientOptions(options={'keepalive': 'true'})
deepgram = DeepgramClient(config=deepgram_config)
dg_connection_options = LiveOptions(
    model='nova-2',
    language=language,
    # Apply smart formatting to the output
    smart_format=True,
    # To get UtteranceEnd, the following must be set:
    # interim_results=True,
    # utterance_end_ms='1000',
    vad_events=True,
    # Time in milliseconds of silence to wait for before finalizing speech
    endpointing=500,
)

polly = boto3.client('polly', 
    region_name='ap-northeast-2',  # Change this to your region
    aws_access_key_id=AWS_ACCESS_KEY_ID,
    aws_secret_access_key=AWS_SECRET_ACCESS_KEY
)


class Assistant:
    def __init__(self, websocket, memory_size=10):
        self.websocket = websocket
        self.transcript_parts = []
        self.transcript_queue = asyncio.Queue()
        self.system_message = ('system', SYSTEM_PROMPT)
        self.chat_messages = []
        self.memory_size = memory_size
        self.httpx_client = httpx.AsyncClient()
        self.finish_event = asyncio.Event()
        self.app = create_app()
    
    async def assistant_chat(self, messages):
        res = self.app.invoke({
            'messages': messages,
        })
        return res
    
    def should_end_conversation(self, text):
        text = text.translate(str.maketrans('', '', string.punctuation))
        text = text.strip().lower()
        return re.search(r'\b(goodbye|bye)\b$', text) is not None
    
    async def text_to_speech(self, text):
        print("text_to_speech", text)

        response = polly.synthesize_speech(
            Text=text,
            OutputFormat='mp3',
            VoiceId=voice_config[language],
            Engine='neural'  # Use neural engine for better quality
        )

        try:
            stream = response["AudioStream"]

            with closing(stream) as stream:
                # Send MP3 header information first
                chunk = stream.read(1024)  # Read first chunk including headers
                if chunk:
                    await self.websocket.send_json({
                        'type': 'audio_start',
                        'format': 'mp3',
                        'chunk': base64.b64encode(chunk).decode('utf-8')
                    })
                
                # Stream the rest of the audio
                while True:
                    chunk = stream.read(8192)  # Standard MP3 chunk size
                    if not chunk:
                        break
                    
                    # Send chunk as base64 encoded string
                    await self.websocket.send_json({
                        'type': 'audio_chunk',
                        'chunk': base64.b64encode(chunk).decode('utf-8')
                    })
                    
                    # Small delay to prevent overwhelming the client
                    await asyncio.sleep(0.01)
            
            # Send end marker
            await self.websocket.send_json({'type': 'audio_end'})
        except Exception as e:
            await self.websocket.send_json({
                'type': 'error',
                'message': str(e)
            })
            
        # headers = {
        #     'Authorization': f'Token {DEEPGRAM_API_KEY}',
        #     'Content-Type': 'application/json'
        # }
        # async with self.httpx_client.stream(
        #     'POST', DEEPGRAM_TTS_URL, headers=headers, json={'text': text}
        # ) as res:
        #     async for chunk in res.aiter_bytes(1024):
        #         await self.websocket.send_bytes(chunk)
    
    async def transcribe_audio(self):
        async def on_message(self_handler, result, **kwargs):
            sentence = result.channel.alternatives[0].transcript
            # print("transcribe_audio_on_message", result.channel.alternatives)
            if len(sentence) == 0:
                return
            if result.is_final:
                self.transcript_parts.append(sentence)
                await self.transcript_queue.put({'type': 'transcript_final', 'content': sentence})
                if result.speech_final:
                    full_transcript = ' '.join(self.transcript_parts)
                    self.transcript_parts = []
                    await self.transcript_queue.put({'type': 'speech_final', 'content': full_transcript})
            else:
                await self.transcript_queue.put({'type': 'transcript_interim', 'content': sentence})
        
        async def on_utterance_end(self_handler, utterance_end, **kwargs):
            print("on_utterance_end:", utterance_end)
            if len(self.transcript_parts) > 0:
                full_transcript = ' '.join(self.transcript_parts)
                self.transcript_parts = []
                await self.transcript_queue.put({'type': 'speech_final', 'content': full_transcript})

        dg_connection = deepgram.listen.asynclive.v('1')
        dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        dg_connection.on(LiveTranscriptionEvents.UtteranceEnd, on_utterance_end)
        if await dg_connection.start(dg_connection_options) is False:
            raise Exception('Failed to connect to Deepgram')
        
        try:
            while not self.finish_event.is_set():
                # Receive audio stream from the client and send it to Deepgram to transcribe it
                data = await self.websocket.receive_bytes()
                await dg_connection.send(data)
        finally:
            await dg_connection.finish()
    
    async def manage_conversation(self):
        while not self.finish_event.is_set():
            transcript = await self.transcript_queue.get()
            if transcript['type'] == 'speech_final':
                if self.should_end_conversation(transcript['content']):
                    self.finish_event.set()
                    await self.websocket.send_json({'type': 'finish'})
                    break

                self.chat_messages.append({'role': 'user', 'content': transcript['content']})
                response = await self.assistant_chat(
                    # [self.system_message] + self.chat_messages[-self.memory_size:]
                    self.chat_messages[-self.memory_size:]
                )

                ai_text = response["messages"][-1].content

                print("ai", ai_text)
                self.chat_messages.append({'role': 'assistant', 'content': ai_text})
                await self.websocket.send_json({'type': 'assistant', 'content': ai_text})
                await self.text_to_speech(ai_text)
            else:
                await self.websocket.send_json(transcript)    
    async def run(self):
        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(self.transcribe_audio())
                tg.create_task(self.manage_conversation())
        except* WebSocketDisconnect:
            print('Client disconnected')
        finally:
            await self.httpx_client.aclose()
            if self.websocket.client_state != WebSocketState.DISCONNECTED:
                await self.websocket.close()
