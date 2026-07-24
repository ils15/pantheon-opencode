from pydantic import BaseModel


class UserCreate(BaseModel):
    email: str
    name: str
    password: str


class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    model_config = {"from_attributes": True}


class ProductCreate(BaseModel):
    name: str
    description: str
    price: float
    owner_id: int


class ProductResponse(BaseModel):
    id: int
    name: str
    description: str
    price: float
    owner_id: int
    model_config = {"from_attributes": True}


class CategoryCreate(BaseModel):
    name: str


class CategoryResponse(BaseModel):
    id: int
    name: str
    model_config = {"from_attributes": True}
