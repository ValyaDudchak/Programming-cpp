const express = require('express')
const multer = require('multer')
const cors = require('cors')
const { createServer } = require('http')
const { Server } = require('socket.io')
const { Worker } = require('worker_threads')
const path = require('path')
const mongoose = require('mongoose')
const Task = require('./models/task')
require('dotenv').config()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
  },
})

const PORT = process.env.PORT || 5002

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.log('MongoDB connection error:', err))

const MAX_FILE_SIZE = 500 * 1024 // 500 KB
const MAX_TIME_LIMIT = 30000 // 30 секунд

app.use(cors())
const users = [
  {
    username: 'admin',
    password: 'admin',
    token:
      'FDjdW2AXhp1VkZAmQ84zOdhayaUyWaZYd98tiIwASteqS9tA8dPtVcjDkwtHpasjFREFT4z5b1e2QkVxDwmjZTwi5dX4evoeXpteUrC2hSCQPgTkjt45hea0kF2Jgu4zm5iWQw1TGh3bF01Po2ayudYm20zo13yu00guufLoXDAf',
  },
]
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ message: 'Необхідна авторизація' })

  try {
    const user = users.find((u) => u.token === token)
    if (!user) return res.status(403).json({ message: 'Необхідна авторизація' })
    next()
  } catch (error) {
    res.status(403).json({ message: 'Необхідна авторизація' })
  }
}

const storage = multer.memoryStorage()
const upload = multer({ storage: storage })

const tasks = new Map()

io.on('connection', (socket) => {
  console.log('Новий клієнт підключено:', socket.id)

  socket.on('join', (jobId) => {
    socket.join(jobId)
    console.log(`Клієнт ${socket.id} приєднався до кімнати ${jobId}`)
  })

  socket.on('disconnect', () => {
    console.log('Клієнт відключився:', socket.id)
  })
})

app.delete('/api/clear-tasks', authMiddleware, async (req, res) => {
  try {
    const deletedTasks = await Task.deleteMany({})
    res.status(200).json({
      message: `Видалено ${deletedTasks.deletedCount} задач`,
    })
  } catch (error) {
    console.error('Помилка очищення задач:', error)
    res.status(500).json({ message: 'Не вдалося очистити задачі.' })
  }
})

app.post(
  '/api/recognize',
  authMiddleware,
  upload.single('image'),
  async (req, res) => {
    const imageBuffer = req.file.buffer
    const jobId = Date.now().toString()
    const inProgressCount = await Task.countDocuments({ status: 'in_progress' })

    if (inProgressCount >= 5) {
      io.emit('error', 'Не можна створити більше 5 задач підряд')
      return res
        .status(400)
        .json({ message: 'Не можна створити більше 5 задач підряд' })
    }
    const task = new Task({
      jobId,
      fileName: req.file.originalname,
      status: 'in_progress',
      progress: 0,
    })
    io.emit('update-history', task)

    await task.save()
    Task.deleteMany({})

    if (req.file.size > MAX_FILE_SIZE) {
      const task = await Task.findOneAndUpdate({ jobId }, { status: 'failed' })
      io.emit('update-history')
      return res.status(400).json({ message: 'Файл занадто великий' })
    }

    res.status(200).json({ jobId, message: 'Завдання розпочато' })

    // запускається worker
    const worker = new Worker(path.join(__dirname, 'tesseractWorker.js'), {
      workerData: { imageBuffer },
    })

    tasks.set(jobId, worker)
    io.emit('update-history')

    // якщо перевищено час виконання - failed
    const timeout = setTimeout(async () => {
      const findedTask = await Task.findOne({ jobId })
      if (worker && findedTask.status === 'in_progress') {
        worker.terminate()
        tasks.delete(jobId)
        io.to(jobId).emit('error', 'Час виконання задачі перевищив ліміт')
        const task = await Task.findOneAndUpdate(
          { jobId },
          { status: 'failed' }
        )
        io.emit('update-history')
      }
    }, MAX_TIME_LIMIT)

    worker.on('message', async (message) => {
      if (message.type === 'progress') {
        io.to(jobId).emit('progress', message.data)
      } else if (message.type === 'result') {
        clearTimeout(timeout)
        const task = await Task.findOneAndUpdate(
          { jobId },
          { status: 'completed', resultText: message.data }
        )
        io.to(jobId).emit('result', message.data)
        io.emit('update-history')
        tasks.delete(jobId)
        worker.terminate()
      } else if (message.type === 'error') {
        clearTimeout(timeout)
        io.to(jobId).emit('error', message.data)
        tasks.delete(jobId)
        worker.terminate()
      }
    })

    worker.on('error', (error) => {
      console.error('Помилка в worker:', error)
      clearTimeout(timeout)
      tasks.delete(jobId)
      worker.terminate()
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Worker завершився з кодом ${code}`)
      }
      tasks.delete(jobId)
    })
  }
)

app.post('/api/cancel/:jobId', authMiddleware, async (req, res) => {
  const jobId = req.params.jobId
  const worker = tasks.get(jobId)
  console.log(worker)
  if (worker) {
    worker.terminate()
    tasks.delete(jobId)
    const task = await Task.findOneAndUpdate({ jobId }, { status: 'canceled' })
    io.emit('update-history', task)
    res.status(200).json({ success: true, message: 'Задача скасована' })
  } else {
    res.status(404).json({ success: false, message: 'Задачу не знайдено' })
  }
})
app.use(upload.none())

app.post('/login', (req, res) => {
  console.log(req.body)
  const { username, password } = req.body

  const user = users.find(
    (u) => u.username === username && u.password === password
  )

  if (user) {
    return res.json({ token: user.token })
  } else {
    return res.status(401).json({ message: 'Невірний логін або пароль' })
  }
})

app.get('/api/history', authMiddleware, async (req, res) => {
  try {
    const tasksHistory = await Task.find().sort({ createdAt: -1 }).limit(10)
    res.json(tasksHistory)
  } catch (err) {
    res
      .status(500)
      .json({ message: 'Помилка при отриманні історії', error: err })
  }
})

httpServer.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`)
})
