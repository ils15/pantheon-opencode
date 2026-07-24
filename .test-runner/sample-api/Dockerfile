FROM python:3.11

WORKDIR /app

# Copy everything at once (bad practice - no layer caching)
COPY . .

# Install all dependencies
RUN pip install -r requirements.txt

# Run as root (security issue)
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
