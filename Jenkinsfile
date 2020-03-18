@Library('jenkins-pipeline') _

node {
  cleanWs()

  try {
    dir('src') {
      stage('checkout source code') {
        checkout scm
      }
      updateGithubCommitStatus('PENDING', "${env.WORKSPACE}/src")

      stage('docker build') {
        image = docker()
      }
      stage('docker push') {
        image.push()
      }
    }
  }
  catch (err) {
    currentBuild.result = 'FAILURE'
    updateGithubCommitStatus('FAILURE', "${env.WORKSPACE}/src")
    throw err
  }

  finally {
    if (currentBuild.result != 'FAILURE') {
      updateGithubCommitStatus('SUCCESS', "${env.WORKSPACE}/src")
    }
  }
}

def docker() {
  docker.withRegistry('https://registry.internal.exoscale.ch') {
    def branch = getGitBranch().replace("/", "-")
    def tag = getGitTag() ?: (branch == "master" ? "latest" : branch)
    return docker.build("registry.internal.exoscale.ch/exoscale/thelounge:${tag}")
  }
}
