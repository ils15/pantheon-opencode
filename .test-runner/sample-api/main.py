from fastapi import FastAPI
from routes import router as users_router
from db import engine
from models import Base

app = FastAPI(title="Sample API")

Base.metadata.create_all(bind=engine)

app.include_router(users_router, prefix="/api")


@app.get("/")
def read_root():
    return {"message": "Welcome to Sample API"}
