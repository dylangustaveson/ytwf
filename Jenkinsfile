pipeline {
  agent any
  stages {
    stage('dockerize') {
      steps {
        sh 'docker build .'
      }
    }
  }
}