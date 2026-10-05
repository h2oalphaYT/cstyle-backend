import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});

counterSchema.statics.next = async function next(name) {
    const doc = await this.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    return doc.seq;
};

const Counter = mongoose.model('Counter', counterSchema);
export default Counter;
