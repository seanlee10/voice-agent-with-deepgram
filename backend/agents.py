from langchain_core.prompts import ChatPromptTemplate

class Agent:
    def __init__(self, state, llm):
        self.state = state
        self.llm = llm

    def update_state(self, key, value):
        self.state = {**self.state, key: value}


class SearchAgent(Agent):
    def invoke(self, prompt_template, text):
        prompt = ChatPromptTemplate.from_template(prompt_template)
        chain = prompt | self.llm | (lambda x: x.content)
        res = chain.invoke({"input": text})
        self.update_state("topic", res)
        return self.state