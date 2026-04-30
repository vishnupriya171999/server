import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },

  provider: {
    type: String,
    default: "gmail",
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

userSchema.methods.toSafeObject = function toSafeObject() {
  return {
    id: String(this._id),
    email: this.email,
    provider: this.provider,
    createdAt: this.createdAt,
  };
};

export default mongoose.model("User", userSchema);
