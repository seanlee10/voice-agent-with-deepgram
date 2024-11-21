from langgraph.graph import END, StateGraph, MessagesState, START
from langchain_core.messages import BaseMessage, AIMessage
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic
from langchain_community.agent_toolkits.load_tools import load_tools
from pydantic import BaseModel
from typing import Annotated, Sequence
from typing_extensions import TypedDict
from dotenv import load_dotenv
import functools
import operator
import os

load_dotenv()

llm = ChatAnthropic(
    model="claude-3-5-haiku-latest"
)

def agent_node(state, agent, name):
    print("state", state)
    result = agent.invoke(state)
    return {
        "messages": [AIMessage(content=result["messages"][-1].content, name=name)]
    }

search_agent = create_react_agent(llm, tools=load_tools(["serpapi"]))
search_agent_node = functools.partial(agent_node, agent=search_agent, name="search_agent")

# The agent state
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], operator.add]


def call_model(state: MessagesState):
    messages = state['messages']
    response = llm.invoke(messages)
    # We return a list, because this will get added to the existing list
    return {"messages": [response]}


def create_app():
    graph = StateGraph(MessagesState)

    graph.add_node("search", search_agent_node)
    # graph.add_node("search", call_model)

    graph.add_edge(START, "search")
    graph.add_edge("search", END)

    return graph.compile()